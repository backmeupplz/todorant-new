import argon2 from "argon2";
import { describe, expect, it, vi } from "vitest";
import { buildApp, EventHub } from "./app.js";
import { MemoryDataStore } from "./memory-store.js";

const appFixture = async (options: { production?: boolean; webOrigin?: string } = {}) => {
  const hub = new EventHub();
  const store = new MemoryDataStore(hub.publish);
  const app = await buildApp({
    store,
    eventHub: hub,
    sessionPepper: "test-pepper-that-is-definitely-long-enough",
    ...options,
    importQueue: {
      verifyOwnership: async () => "legacy-user",
      enqueue: async () => undefined
    }
  });
  return { app, store };
};

const cookieFrom = (header: string | string[] | undefined): string => {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(";", 1)[0] ?? "";
};

describe("email and password authentication", () => {
  it("normalizes signup email, hashes the password, and uses an http-only same-site cookie", async () => {
    const { app, store } = await appFixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: " Person@Example.COM ", password: "correct horse battery staple" }
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    const user = await store.findUserByEmail("person@example.com");
    expect(user?.passwordHash).not.toContain("correct horse");
    expect(argon2.needsRehash(user?.passwordHash ?? "", {
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1
    })).toBe(false);
    await app.close();
  });

  it("returns generic login errors and requires CSRF for cookie writes", async () => {
    const { app } = await appFixture();
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "person@example.com", password: "correct horse battery staple" }
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "missing@example.com", password: "incorrect password" }
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "person@example.com", password: "incorrect password" }
    });
    expect(missing.json()).toEqual(wrong.json());

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "person@example.com", password: "correct horse battery staple" }
    });
    const cookie = cookieFrom(login.headers["set-cookie"]);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: { cookie },
      payload: {}
    });
    expect(rejected.statusCode).toBe(403);

    const unsafe = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: { cookie, "x-csrf-token": login.json().csrfToken as string },
      payload: {
        operationId: "00000000-0000-4000-8000-000000000031",
        taskId: "00000000-0000-4000-8000-000000000032",
        deviceId: "device-a",
        baseRevision: 0,
        command: "create",
        changedFields: { text: "Safe", id: "00000000-0000-4000-8000-000000000099" },
        clientTime: new Date().toISOString()
      }
    });
    expect(unsafe.statusCode).toBe(400);
    await app.close();
  });

  it("upgrades legacy password hashes after a successful login", async () => {
    const { app, store } = await appFixture();
    const password = "correct horse battery staple";
    const weakHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1
    });
    await store.createUser("legacy-hash@example.com", weakHash);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "legacy-hash@example.com", password }
    });
    expect(login.statusCode).toBe(200);
    const upgraded = await store.findUserByEmail("legacy-hash@example.com");
    expect(upgraded?.passwordHash).not.toBe(weakHash);
    expect(argon2.needsRehash(upgraded?.passwordHash ?? "", {
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1
    })).toBe(false);
    await app.close();
  });

  it("requires the canonical production origin and sets a host-only secure cookie", async () => {
    const { app } = await appFixture({ production: true, webOrigin: "https://new.todorant.com" });
    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "person@example.com", password: "correct horse battery staple" }
    });
    expect(missingOrigin.statusCode).toBe(403);

    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      headers: { origin: "https://attacker.example" },
      payload: { email: "person@example.com", password: "correct horse battery staple" }
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      headers: { origin: "https://new.todorant.com" },
      payload: { email: "person@example.com", password: "correct horse battery staple" }
    });
    expect(signup.statusCode).toBe(201);
    expect(signup.headers["set-cookie"]).toContain("__Host-todorant_session=");
    expect(signup.headers["set-cookie"]).toContain("Secure");
    expect(signup.headers["cache-control"]).toBe("no-store");
    const cookie = cookieFrom(signup.headers["set-cookie"]);
    await expect(app.injectWS("/ws?cursor=0", {
      headers: { cookie, origin: "https://attacker.example" }
    })).rejects.toThrow(/403/u);
    const websocket = await app.injectWS("/ws?cursor=0", {
      headers: { cookie, origin: "https://new.todorant.com" }
    });
    websocket.close();
    await app.close();
  });

  it("rejects unsafe settings and cursors and does not expose unexpected store errors", async () => {
    const { app, store } = await appFixture();
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "person@example.com", password: "correct horse battery staple" }
    });
    const cookie = cookieFrom(signup.headers["set-cookie"]);
    const headers = { cookie, "x-csrf-token": signup.json().csrfToken as string };

    expect((await app.inject({ method: "GET", url: "/api/snapshot?cursor=Infinity", headers })).statusCode).toBe(400);
    expect((await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers,
      payload: { theme: "dark", unexpected: "value" }
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers,
      payload: { epicGoals: { launch: 4 } }
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/api/commands",
      headers,
      payload: {
        operationId: "00000000-0000-4000-8000-000000000043",
        taskId: "00000000-0000-4000-8000-000000000044",
        deviceId: "retired-client",
        baseRevision: 0,
        command: "create",
        changedFields: { text: "Must be rejected", epicId: "launch" },
        clientTime: new Date().toISOString()
      }
    })).statusCode).toBe(400);

    vi.spyOn(store, "applyCommand").mockRejectedValueOnce(new Error("password authentication failed for postgres"));
    const command = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers,
      payload: {
        operationId: "00000000-0000-4000-8000-000000000041",
        taskId: "00000000-0000-4000-8000-000000000042",
        deviceId: "device-a",
        baseRevision: 0,
        command: "create",
        changedFields: { text: "Safe" },
        clientTime: new Date().toISOString()
      }
    });
    expect(command.statusCode).toBe(409);
    expect(command.json()).toEqual({ error: "Command rejected" });
    expect(command.body).not.toContain("postgres");
    await app.close();
  });
});
