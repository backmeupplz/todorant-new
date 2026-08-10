import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, EventHub } from "./app.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const cookieFrom = (header: string | string[] | undefined): string => {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(";", 1)[0] ?? "";
};

suite("PostgreSQL REST and WebSocket synchronization", () => {
  const hub = new EventHub();
  const postgres = createPostgresStore(databaseUrl ?? "postgresql://unused", hub.publish);
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await postgres.pool.query(
      "TRUNCATE reports, task_events, operations, tasks, legacy_imports, import_runs, sessions, users RESTART IDENTITY CASCADE"
    );
    app = await buildApp({
      store: postgres.store,
      eventHub: hub,
      sessionPepper: "integration-pepper-that-is-long-enough",
      importQueue: {
        verifyOwnership: async () => "507f1f77bcf86cd799439011",
        enqueue: async () => undefined
      }
    });
  });

  afterAll(async () => {
    await app?.close();
    await postgres.pool.end();
  });

  const signup = async (email: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "correct horse battery staple" }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { csrfToken: string; user: { id: string } };
    return { cookie: cookieFrom(response.headers["set-cookie"]), ...body } as {
      cookie: string;
      csrfToken: string;
      user: { id: string };
    };
  };

  const send = async (
    session: { cookie: string; csrfToken: string },
    operation: Record<string, unknown>
  ) => app.inject({
    method: "POST",
    url: "/api/commands",
    headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
    payload: operation
  });

  it("persists idempotent commands, delegated realtime events, conflicts, tombstones, and ranks", async () => {
    const owner = await signup("owner@example.com");
    const delegate = await signup("delegate@example.com");
    const taskId = "00000000-0000-4000-8000-000000000101";
    const base = {
      taskId,
      deviceId: "integration-owner",
      clientTime: new Date().toISOString()
    };
    const created = await send(owner, {
      ...base,
      operationId: "00000000-0000-4000-8000-000000000102",
      baseRevision: 0,
      command: "create",
      changedFields: { text: "Persist me" }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().task.revision).toBe(1);
    const duplicate = await send(owner, {
      ...base,
      operationId: "00000000-0000-4000-8000-000000000102",
      baseRevision: 0,
      command: "create",
      changedFields: { text: "Persist me" }
    });
    expect(duplicate.json()).toMatchObject({ duplicate: true, task: { revision: 1 } });

    const assign = (baseRevision: number, operationId: string) => send(owner, {
      ...base,
      operationId,
      baseRevision,
      command: "delegate-assign",
      changedFields: {},
      delegationUserId: delegate.user.id
    });
    const respond = (response: "accept" | "reject", baseRevision: number, operationId: string) => app.inject({
      method: "POST",
      url: `/api/delegations/${taskId}/${response}`,
      headers: { cookie: delegate.cookie, "x-csrf-token": delegate.csrfToken },
      payload: { baseRevision, operationId }
    });

    const pending = await assign(1, "00000000-0000-4000-8000-000000000109");
    expect(pending.json()).toMatchObject({
      task: { revision: 2, delegateId: null, delegation: { delegateId: delegate.user.id, status: "pending" } }
    });
    const invitations = await app.inject({
      method: "GET",
      url: "/api/delegations/invitations",
      headers: { cookie: delegate.cookie }
    });
    expect(invitations.json()).toMatchObject({
      invitations: [{ taskId, revision: 2, ownerEmail: "owner@example.com" }]
    });
    const pendingSnapshot = await app.inject({
      method: "GET",
      url: "/api/snapshot?cursor=0",
      headers: { cookie: delegate.cookie }
    });
    expect(pendingSnapshot.json().tasks).toHaveLength(0);
    expect(pendingSnapshot.json().events).toHaveLength(0);
    const pendingHistory = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/history`,
      headers: { cookie: delegate.cookie }
    });
    expect(pendingHistory.statusCode).toBe(404);

    const rejected = await respond("reject", 2, "00000000-0000-4000-8000-000000000110");
    expect(rejected.statusCode).toBe(204);
    expect((await app.inject({
      method: "GET",
      url: "/api/delegations/invitations",
      headers: { cookie: delegate.cookie }
    })).json().invitations).toHaveLength(0);

    expect((await assign(3, "00000000-0000-4000-8000-000000000111")).json()).toMatchObject({
      task: { revision: 4, delegateId: null, delegation: { status: "pending" } }
    });
    const accepted = await respond("accept", 4, "00000000-0000-4000-8000-000000000112");
    expect(accepted.json()).toMatchObject({
      task: { revision: 5, delegateId: delegate.user.id, delegation: { status: "accepted" } }
    });
    const delegatedSnapshot = await app.inject({
      method: "GET",
      url: "/api/snapshot?cursor=0",
      headers: { cookie: delegate.cookie }
    });
    expect(delegatedSnapshot.json().tasks).toHaveLength(1);

    const websocket = await app.injectWS("/ws?cursor=5", { headers: { cookie: delegate.cookie } });
    const event = new Promise<Record<string, unknown>>((resolve) => {
      websocket.on("message", (data: Buffer) => {
        const payload = JSON.parse(String(data)) as Record<string, unknown>;
        if (payload.type === "event") resolve(payload);
      });
    });
    const ownerEdit = await send(owner, {
      ...base,
      operationId: "00000000-0000-4000-8000-000000000103",
      baseRevision: 5,
      command: "update",
      changedFields: { note: "Owner edit" }
    });
    expect(ownerEdit.statusCode).toBe(200);
    await expect(event).resolves.toMatchObject({ type: "event", event: { task: { note: "Owner edit" } } });

    const delegateEditOperation = {
      ...base,
      deviceId: "integration-delegate",
      operationId: "00000000-0000-4000-8000-000000000104",
      baseRevision: 5,
      command: "update",
      changedFields: { note: "Offline delegate edit" }
    };
    const delegateEdit = await send(delegate, delegateEditOperation);
    expect(delegateEdit.json()).toMatchObject({
      task: { note: "Owner edit", revision: 7 },
      conflict: { fields: ["note"], mine: { changedFields: { note: "Offline delegate edit" } } }
    });
    expect((await send(delegate, delegateEditOperation)).json()).toMatchObject({
      duplicate: true,
      task: { revision: 7 }
    });

    const deleted = await send(owner, {
      ...base,
      operationId: "00000000-0000-4000-8000-000000000105",
      baseRevision: 7,
      command: "delete",
      changedFields: {}
    });
    expect(deleted.json().task.deletedAt).toBeTruthy();
    const staleEdit = await send(delegate, {
      ...base,
      deviceId: "integration-delegate",
      operationId: "00000000-0000-4000-8000-000000000106",
      baseRevision: 7,
      command: "update",
      changedFields: { text: "Cannot resurrect" }
    });
    expect(staleEdit.json()).toMatchObject({ task: { text: "Persist me" }, conflict: { fields: ["text"] } });
    expect(staleEdit.json().task.deletedAt).toBeTruthy();

    const restored = await send(owner, {
      ...base,
      operationId: "00000000-0000-4000-8000-000000000107",
      baseRevision: 9,
      command: "restore",
      changedFields: {}
    });
    expect(restored.json().task.revision).toBe(10);
    const revocationEvent = new Promise<Record<string, unknown>>((resolve) => {
      websocket.on("message", (data: Buffer) => {
        const payload = JSON.parse(String(data)) as Record<string, unknown>;
        const received = payload.event as { operationId?: string } | undefined;
        if (received?.operationId === "00000000-0000-4000-8000-000000000108") resolve(payload);
      });
    });
    const revoked = await send(owner, {
      ...base,
      operationId: "00000000-0000-4000-8000-000000000108",
      baseRevision: 10,
      command: "delegate-revoke",
      changedFields: {}
    });
    expect(revoked.json()).toMatchObject({
      task: { revision: 11, delegateId: null, delegation: { status: "revoked" } }
    });
    await expect(revocationEvent).resolves.toMatchObject({
      type: "event",
      event: { task: { id: taskId, delegateId: null } }
    });
    const revokedReplay = await send(delegate, delegateEditOperation);
    expect(revokedReplay.statusCode).toBe(409);
    expect(revokedReplay.json()).toEqual({ error: "Task not found" });

    const pendingAgain = await assign(11, "00000000-0000-4000-8000-000000000113");
    expect(pendingAgain.json()).toMatchObject({ task: { revision: 12, delegation: { status: "pending" } } });
    const pendingReplay = await send(delegate, delegateEditOperation);
    expect(pendingReplay.statusCode).toBe(409);
    expect(pendingReplay.json()).toEqual({ error: "Task not found" });
    const disguisedPendingReplay = await respond(
      "accept",
      12,
      "00000000-0000-4000-8000-000000000104"
    );
    expect(disguisedPendingReplay.statusCode).toBe(409);
    expect(disguisedPendingReplay.json()).toEqual({ error: "Task not found" });
    expect((await respond("reject", 12, "00000000-0000-4000-8000-000000000114")).statusCode).toBe(204);
    const rejectedReplay = await send(delegate, delegateEditOperation);
    expect(rejectedReplay.statusCode).toBe(409);
    expect(rejectedReplay.json()).toEqual({ error: "Task not found" });

    const revokedSnapshot = await app.inject({
      method: "GET",
      url: "/api/snapshot?cursor=0",
      headers: { cookie: delegate.cookie }
    });
    expect(revokedSnapshot.json().tasks).toHaveLength(0);
    expect(revokedSnapshot.json().events).toHaveLength(0);

    const revokedHistory = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/history`,
      headers: { cookie: delegate.cookie }
    });
    expect(revokedHistory.statusCode).toBe(404);

    websocket.close();
    const freshWebsocket = await app.injectWS("/ws?cursor=0", { headers: { cookie: delegate.cookie } });
    const firstFreshMessage = new Promise<Record<string, unknown>>((resolve) => {
      freshWebsocket.once("message", (data: Buffer) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    await expect(firstFreshMessage).resolves.toMatchObject({ type: "ready" });
    freshWebsocket.close();

    const delegateTaskId = "00000000-0000-4000-8000-000000000201";
    expect((await send(delegate, {
      ...base,
      taskId: delegateTaskId,
      deviceId: "integration-delegate",
      operationId: "00000000-0000-4000-8000-000000000115",
      baseRevision: 0,
      command: "create",
      changedFields: { text: "Delegate-owned" }
    })).statusCode).toBe(200);
    const retargetedReplay = await send(delegate, { ...delegateEditOperation, taskId: delegateTaskId });
    expect(retargetedReplay.statusCode).toBe(409);
    expect(retargetedReplay.json()).toEqual({ error: "Task not found" });
  });
});
