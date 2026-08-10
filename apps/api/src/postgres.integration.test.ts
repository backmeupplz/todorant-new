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
      changedFields: { text: "Persist me", delegateId: delegate.user.id }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().task.revision).toBe(1);
    const duplicate = await send(owner, {
      ...base,
      operationId: "00000000-0000-4000-8000-000000000102",
      baseRevision: 0,
      command: "create",
      changedFields: { text: "Persist me", delegateId: delegate.user.id }
    });
    expect(duplicate.json()).toMatchObject({ duplicate: true, task: { revision: 1 } });

    const delegatedSnapshot = await app.inject({
      method: "GET",
      url: "/api/snapshot?cursor=0",
      headers: { cookie: delegate.cookie }
    });
    expect(delegatedSnapshot.json().tasks).toHaveLength(1);

    const websocket = await app.injectWS("/ws?cursor=1", { headers: { cookie: delegate.cookie } });
    const event = new Promise<Record<string, unknown>>((resolve) => {
      websocket.on("message", (data: Buffer) => {
        const payload = JSON.parse(String(data)) as Record<string, unknown>;
        if (payload.type === "event") resolve(payload);
      });
    });
    const ownerEdit = await send(owner, {
      ...base,
      operationId: "00000000-0000-4000-8000-000000000103",
      baseRevision: 1,
      command: "update",
      changedFields: { note: "Owner edit" }
    });
    expect(ownerEdit.statusCode).toBe(200);
    await expect(event).resolves.toMatchObject({ type: "event", event: { task: { note: "Owner edit" } } });

    const delegateEdit = await send(delegate, {
      ...base,
      deviceId: "integration-delegate",
      operationId: "00000000-0000-4000-8000-000000000104",
      baseRevision: 1,
      command: "update",
      changedFields: { note: "Offline delegate edit" }
    });
    expect(delegateEdit.json()).toMatchObject({
      task: { note: "Owner edit", revision: 3 },
      conflict: { fields: ["note"], mine: { changedFields: { note: "Offline delegate edit" } } }
    });

    const deleted = await send(owner, {
      ...base,
      operationId: "00000000-0000-4000-8000-000000000105",
      baseRevision: 3,
      command: "delete",
      changedFields: {}
    });
    expect(deleted.json().task.deletedAt).toBeTruthy();
    const staleEdit = await send(delegate, {
      ...base,
      deviceId: "integration-delegate",
      operationId: "00000000-0000-4000-8000-000000000106",
      baseRevision: 3,
      command: "update",
      changedFields: { text: "Cannot resurrect" }
    });
    expect(staleEdit.json()).toMatchObject({ task: { text: "Persist me" }, conflict: { fields: ["text"] } });
    expect(staleEdit.json().task.deletedAt).toBeTruthy();

    const restored = await send(owner, {
      ...base,
      operationId: "00000000-0000-4000-8000-000000000107",
      baseRevision: 5,
      command: "restore",
      changedFields: {}
    });
    expect(restored.json().task.revision).toBe(6);
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
      baseRevision: 6,
      command: "update",
      changedFields: { delegateId: null }
    });
    expect(revoked.json()).toMatchObject({ task: { revision: 7, delegateId: null } });
    await expect(revocationEvent).resolves.toMatchObject({
      type: "event",
      event: { task: { id: taskId, delegateId: null } }
    });
    const revokedSnapshot = await app.inject({
      method: "GET",
      url: "/api/snapshot?cursor=0",
      headers: { cookie: delegate.cookie }
    });
    expect(revokedSnapshot.json().tasks).toHaveLength(0);
    websocket.close();
  });
});
