import { describe, expect, it } from "vitest";
import { buildApp, EventHub } from "./app.js";
import { MemoryDataStore } from "./memory-store.js";

const appFixture = async () => {
  const hub = new EventHub();
  const store = new MemoryDataStore(hub.publish);
  const app = await buildApp({
    store,
    eventHub: hub,
    sessionPepper: "test-pepper-that-is-definitely-long-enough",
    importQueue: { enqueue: async () => undefined }
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
});
