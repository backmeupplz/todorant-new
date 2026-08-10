import { describe, expect, it } from "vitest";
import { buildApp, EventHub } from "./app.js";
import { MemoryDataStore } from "./memory-store.js";

const cookieFrom = (header: string | string[] | undefined): string => {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(";", 1)[0] ?? "";
};

describe("aggregate reports", () => {
  it("derives report-ready history and shares only aggregate public data", async () => {
    const hub = new EventHub();
    const store = new MemoryDataStore(hub.publish);
    const app = await buildApp({
      store,
      eventHub: hub,
      sessionPepper: "report-pepper-that-is-definitely-long-enough",
      importQueue: { verifyOwnership: async () => "legacy-user", enqueue: async () => undefined }
    });
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "report@example.com", password: "correct horse battery staple" }
    });
    const cookie = cookieFrom(signup.headers["set-cookie"]);
    const csrf = signup.json().csrfToken as string;
    const headers = { cookie, "x-csrf-token": csrf };
    const taskId = "00000000-0000-4000-8000-000000000401";
    await app.inject({
      method: "POST",
      url: "/api/commands",
      headers,
      payload: {
        operationId: "00000000-0000-4000-8000-000000000402",
        taskId,
        deviceId: "report-device",
        baseRevision: 0,
        command: "create",
        changedFields: {
          text: "Private task title",
          frog: true,
          schedule: { month: "2026-08", date: "2026-08-09", time: null, timezone: "UTC" }
        }
      }
    });
    await app.inject({
      method: "POST",
      url: "/api/commands",
      headers,
      payload: {
        operationId: "00000000-0000-4000-8000-000000000403",
        taskId,
        deviceId: "report-device",
        baseRevision: 1,
        command: "complete",
        changedFields: {}
      }
    });
    const share = await app.inject({ method: "POST", url: "/api/report/share", headers });
    expect(share.statusCode).toBe(200);
    const publicReport = await app.inject({ method: "GET", url: `/api/report/public/${share.json().id as string}` });
    expect(publicReport.json()).toMatchObject({
      completedTodosMap: { "2026-08-09": 1 },
      completedFrogsMap: { "2026-08-09": 1 }
    });
    expect(publicReport.body).not.toContain("Private task title");
    expect(publicReport.body).not.toContain("report@example.com");
    await app.close();
  });
});
