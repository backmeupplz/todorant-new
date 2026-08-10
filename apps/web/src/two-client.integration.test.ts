import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CommandResult, DelegationInvite } from "@todorant/domain";
import { buildApp, EventHub } from "../../api/src/app.js";
import { MemoryDataStore } from "../../api/src/memory-store.js";
import { localDb } from "./db.js";
import {
  api,
  applyRemoteCommandResult,
  pendingCount,
  queueCommand,
  startSync,
  stopSync,
  tasks
} from "./sync.js";

const cookieFrom = (header: string | string[] | undefined): string => {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(";", 1)[0] ?? "";
};

describe("two-client web synchronization", () => {
  const hub = new EventHub();
  const store = new MemoryDataStore(hub.publish);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let activeCookie = "";
  const network = { onLine: true };

  beforeAll(async () => {
    app = await buildApp({
      store,
      eventHub: hub,
      sessionPepper: "two-client-integration-pepper",
      importQueue: {
        verifyOwnership: async () => "legacy-user",
        enqueue: async () => undefined
      }
    });

    vi.stubGlobal("navigator", network);
    vi.stubGlobal("location", { protocol: "http:", host: "todorant.test" });
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      confirm: () => true
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://todorant.test");
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      if (activeCookie) headers.cookie = activeCookie;
      const options = {
        method: (init.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "HEAD",
        url: `${target.pathname}${target.search}`,
        headers
      };
      const response = typeof init.body === "string"
        ? await app.inject({ ...options, payload: init.body })
        : await app.inject(options);
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : String(value));
      }
      return new Response(response.body || null, {
        status: response.statusCode,
        headers: responseHeaders
      });
    });

    class InjectedWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = InjectedWebSocket.CONNECTING;
      private socket: Awaited<ReturnType<typeof app.injectWS>> | undefined;
      private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

      constructor(url: string) {
        const target = new URL(url);
        const cookie = activeCookie;
        void app.injectWS(`${target.pathname}${target.search}`, { headers: { cookie } }).then((socket) => {
          this.socket = socket;
          this.readyState = InjectedWebSocket.OPEN;
          socket.on("message", (data: unknown) => this.dispatch("message", { data: String(data) }));
          socket.on("close", () => {
            this.readyState = InjectedWebSocket.CLOSED;
            this.dispatch("close", {});
          });
          this.dispatch("open", {});
        });
      }

      addEventListener(type: string, listener: (event: { data?: string }) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      close() {
        this.socket?.close();
        this.readyState = InjectedWebSocket.CLOSED;
      }

      private dispatch(type: string, event: { data?: string }) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    vi.stubGlobal("WebSocket", InjectedWebSocket);
  });

  afterAll(async () => {
    await stopSync();
    await app.close();
    vi.unstubAllGlobals();
  });

  const signup = async (email: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "correct horse battery staple" }
    });
    const body = response.json() as { csrfToken: string; user: { id: string } };
    return { ...body, cookie: cookieFrom(response.headers["set-cookie"]) };
  };

  const waitForFlush = async () => {
    await vi.waitFor(() => expect(pendingCount.value).toBe(0), { timeout: 2_000 });
  };

  it("chains owner edits, keeps pending data private, applies WebSocket events, and purges an offline former delegate", async () => {
    const owner = await signup("two-client-owner@example.com");
    const delegate = await signup("two-client-delegate@example.com");
    const taskId = "00000000-0000-4000-8000-000000000401";

    activeCookie = owner.cookie;
    await startSync(owner.user.id, owner.csrfToken);
    await queueCommand(taskId, "create", { text: "Shared through real web sync" });
    await queueCommand(taskId, "update", { note: "Owner note" });
    await queueCommand(taskId, "delegate-assign", {}, { delegationUserId: delegate.user.id });
    await waitForFlush();
    expect(tasks.value[0]).toMatchObject({ revision: 3, note: "Owner note", delegateId: null, delegation: { status: "pending" } });
    await stopSync();

    activeCookie = delegate.cookie;
    await startSync(delegate.user.id, delegate.csrfToken);
    expect(tasks.value).toEqual([]);
    const invitations = await api.request<{ invitations: DelegationInvite[] }>("/api/delegations/invitations");
    expect(invitations.invitations).toMatchObject([{ taskId, revision: 3 }]);
    const accepted = await api.request<CommandResult>(`/api/delegations/${taskId}/accept`, {
      method: "POST",
      body: JSON.stringify({ operationId: crypto.randomUUID(), baseRevision: 3 })
    });
    await applyRemoteCommandResult(accepted);
    expect(tasks.value[0]).toMatchObject({ revision: 4, delegateId: delegate.user.id, delegation: { status: "accepted" } });

    await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrfToken },
      payload: {
        operationId: "00000000-0000-4000-8000-000000000402",
        taskId,
        deviceId: "owner-second-client",
        baseRevision: 4,
        command: "update",
        changedFields: { note: "Arrived over WebSocket" },
        clientTime: new Date().toISOString()
      }
    });
    await vi.waitFor(() => expect(tasks.value[0]?.note).toBe("Arrived over WebSocket"), { timeout: 2_000 });

    network.onLine = false;
    await queueCommand(taskId, "update", { epicId: "Offline delegate edit" });
    expect(pendingCount.value).toBe(1);
    expect((await localDb()).get("tasks", taskId)).resolves.toMatchObject({ epicId: "Offline delegate edit" });
    await stopSync();

    network.onLine = true;
    activeCookie = owner.cookie;
    await startSync(owner.user.id, owner.csrfToken);
    expect(tasks.value[0]).toMatchObject({ revision: 5, note: "Arrived over WebSocket" });
    await queueCommand(taskId, "delegate-revoke");
    await waitForFlush();
    expect(tasks.value[0]).toMatchObject({ revision: 6, delegateId: null, delegation: { status: "revoked" } });
    await stopSync();

    activeCookie = delegate.cookie;
    await startSync(delegate.user.id, delegate.csrfToken);
    expect(tasks.value).toEqual([]);
    expect(pendingCount.value).toBe(0);
    expect(await (await localDb()).get("tasks", taskId)).toBeUndefined();
    expect(await (await localDb()).count("operations")).toBe(0);
  });
});
