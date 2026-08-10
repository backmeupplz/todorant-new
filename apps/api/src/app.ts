import { createHmac, randomBytes } from "node:crypto";
import argon2 from "argon2";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { normalizeEmail, type SyncEvent, type Task, type TaskOperation } from "@todorant/domain";
import type { DataStore, ImportRun, SessionRecord } from "./store.js";

const sessionCookie = "todorant_session";
const sessionDurationMs = 1000 * 60 * 60 * 24 * 14;
const authError = "Email or password is incorrect";
const argonOptions = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const safeConflictMessages = new Set([
  "Tasks in the current month need a specific date",
  "Task not found",
  "Task already exists",
  "Base revision is ahead of the canonical task",
  "Only the owner can change delegation",
  "Delegation invitation not found",
  "That delegate account is not available",
  "Revoke the current delegation first",
  "Frog tasks cannot be skipped",
  "Delegation is not pending",
  "Delegation is not active",
  "Invalid ordering neighbors"
]);

type AuthenticatedSession = SessionRecord & {
  user: { id: string; email: string; settings: Record<string, unknown> };
};

declare module "fastify" {
  interface FastifyRequest {
    authSession: AuthenticatedSession | null;
  }
}

export type ImportQueue = {
  verifyOwnership(email: string, legacyToken: string): Promise<string>;
  enqueue(run: ImportRun, legacyUserId: string): Promise<void>;
};

export class EventHub {
  private readonly listeners = new Map<string, Set<(event: SyncEvent) => void>>();

  publish = (userId: string, event: SyncEvent): void => {
    for (const listener of this.listeners.get(userId) ?? []) listener(event);
  };

  subscribe(userId: string, listener: (event: SyncEvent) => void): () => void {
    const listeners = this.listeners.get(userId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(userId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(userId);
    };
  }
}

type AppOptions = {
  store: DataStore;
  eventHub: EventHub;
  importQueue: ImportQueue;
  sessionPepper: string;
  production?: boolean;
  logger?: boolean;
  webOrigin?: string;
};

const hashToken = (token: string, pepper: string): string =>
  createHmac("sha256", pepper).update(token).digest("hex");

const credentials = (body: unknown): { email: string; password: string } | null => {
  if (!body || typeof body !== "object") return null;
  const input = body as Record<string, unknown>;
  if (typeof input.email !== "string" || typeof input.password !== "string") return null;
  const email = normalizeEmail(input.email);
  if (email.length > 254 || !/^\S+@\S+\.\S+$/u.test(email) || input.password.length < 10 || input.password.length > 256) return null;
  return { email, password: input.password };
};

const parseCursor = (value: unknown): number | null => {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d{1,16}$/u.test(value)) return null;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : null;
};

const parseSettings = (body: unknown): Record<string, unknown> | null => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const allowed = new Set([
    "theme",
    "showTodayOnAddTodo",
    "newTodosGoFirst",
    "preserveOrderByTime",
    "showMoreByDefault",
    "duplicateTagInBreakdown",
    "firstDayOfWeek",
    "startTimeOfDay",
    "epicGoals"
  ]);
  if (Object.keys(input).length === 0 || Object.keys(input).some((key) => !allowed.has(key))) return null;
  const settings: Record<string, unknown> = {};
  if (input.theme !== undefined) {
    if (!["system", "light", "dark"].includes(String(input.theme))) return null;
    settings.theme = input.theme;
  }
  for (const key of [
    "showTodayOnAddTodo",
    "newTodosGoFirst",
    "preserveOrderByTime",
    "showMoreByDefault",
    "duplicateTagInBreakdown"
  ]) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") return null;
      settings[key] = input[key];
    }
  }
  if (input.firstDayOfWeek !== undefined) {
    if (![0, 1, 6].includes(input.firstDayOfWeek as number)) return null;
    settings.firstDayOfWeek = input.firstDayOfWeek;
  }
  if (input.startTimeOfDay !== undefined) {
    if (typeof input.startTimeOfDay !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(input.startTimeOfDay)) return null;
    settings.startTimeOfDay = input.startTimeOfDay;
  }
  if (input.epicGoals !== undefined) {
    if (!input.epicGoals || typeof input.epicGoals !== "object" || Array.isArray(input.epicGoals)) return null;
    const goals = input.epicGoals as Record<string, unknown>;
    if (
      Object.keys(goals).length > 100 ||
      Object.entries(goals).some(([key, value]) =>
        key.length < 1 || key.length > 100 || typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000
      )
    ) return null;
    settings.epicGoals = goals;
  }
  return settings;
};

const publicConflictMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && safeConflictMessages.has(error.message) ? error.message : fallback;

const parseOperation = (body: unknown): TaskOperation | null => {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const commands = [
    "create", "update", "complete", "reopen", "skip", "delete", "restore", "reorder", "tags",
    "delegate-assign", "delegate-revoke"
  ] as const;
  if (
    typeof value.operationId !== "string" ||
    !uuidPattern.test(value.operationId) ||
    typeof value.taskId !== "string" ||
    !uuidPattern.test(value.taskId) ||
    typeof value.deviceId !== "string" ||
    value.deviceId.length < 1 ||
    value.deviceId.length > 128 ||
    typeof value.baseRevision !== "number" ||
    !Number.isInteger(value.baseRevision) ||
    value.baseRevision < 0 ||
    typeof value.command !== "string" ||
    !commands.includes(value.command as (typeof commands)[number]) ||
    !value.changedFields ||
    typeof value.changedFields !== "object"
  ) return null;

  const source = value.changedFields as Record<string, unknown>;
  const allowedFields = new Set(["text", "note", "frog", "epicId", "schedule", "repetitive", "encryption", "parentId"]);
  if (Object.keys(source).some((key) => !allowedFields.has(key))) return null;
  const changedFields: TaskOperation["changedFields"] = {};
  if (source.text !== undefined) {
    if (typeof source.text !== "string" || source.text.trim().length < 1 || source.text.length > 1_000) return null;
    changedFields.text = source.text;
  }
  if (source.note !== undefined) {
    if (typeof source.note !== "string" || source.note.length > 20_000) return null;
    changedFields.note = source.note;
  }
  if (source.frog !== undefined) {
    if (typeof source.frog !== "boolean") return null;
    changedFields.frog = source.frog;
  }
  if (source.repetitive !== undefined) {
    if (typeof source.repetitive !== "boolean") return null;
    changedFields.repetitive = source.repetitive;
  }
  for (const key of ["epicId"] as const) {
    if (source[key] !== undefined) {
      if (source[key] !== null && (typeof source[key] !== "string" || String(source[key]).length > 128)) return null;
      changedFields[key] = source[key] as string | null;
    }
  }
  if (source.schedule !== undefined) {
    if (!source.schedule || typeof source.schedule !== "object") return null;
    const schedule = source.schedule as Record<string, unknown>;
    if (Object.keys(schedule).some((key) => !["month", "date", "time", "timezone"].includes(key))) return null;
    if (![schedule.month, schedule.date, schedule.time, schedule.timezone].every((entry) => entry === null || typeof entry === "string")) return null;
    if (schedule.month !== null && !/^\d{4}-\d{2}$/u.test(schedule.month as string)) return null;
    if (schedule.date !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(schedule.date as string)) return null;
    if (schedule.time !== null && !/^\d{2}:\d{2}$/u.test(schedule.time as string)) return null;
    if (typeof schedule.timezone === "string" && schedule.timezone.length > 64) return null;
    changedFields.schedule = {
      month: schedule.month as string | null,
      date: schedule.date as string | null,
      time: schedule.time as string | null,
      timezone: schedule.timezone as string | null
    };
  }
  if (source.parentId !== undefined) {
    if (source.parentId !== null && (typeof source.parentId !== "string" || !uuidPattern.test(source.parentId))) return null;
    changedFields.parentId = source.parentId as string | null;
  }
  if (source.encryption !== undefined) {
    if (source.encryption === null) changedFields.encryption = null;
    else {
      if (!source.encryption || typeof source.encryption !== "object") return null;
      const encryption = source.encryption as Record<string, unknown>;
      if (
        typeof encryption.algorithm !== "string" ||
        !["AES-256-GCM/PBKDF2-SHA256", "legacy-aes"].includes(encryption.algorithm) ||
        typeof encryption.keyId !== "string" ||
        encryption.keyId.length < 1 ||
        encryption.keyId.length > 128
      ) return null;
      changedFields.encryption = { algorithm: encryption.algorithm, keyId: encryption.keyId };
    }
  }

  const operation: TaskOperation = {
    operationId: value.operationId,
    taskId: value.taskId,
    deviceId: value.deviceId,
    baseRevision: value.baseRevision,
    command: value.command as TaskOperation["command"],
    changedFields,
    clientTime:
      typeof value.clientTime === "string" && !Number.isNaN(Date.parse(value.clientTime))
        ? new Date(value.clientTime).toISOString()
        : new Date().toISOString()
  };
  if (value.skipDate !== undefined) {
    if (typeof value.skipDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.skipDate)) return null;
    operation.skipDate = value.skipDate;
  }
  if (value.ordering !== undefined) {
    if (!value.ordering || typeof value.ordering !== "object") return null;
    const ordering = value.ordering as Record<string, unknown>;
    if (![ordering.beforeId, ordering.afterId].every((id) => id === null || (typeof id === "string" && uuidPattern.test(id)))) return null;
    operation.ordering = { beforeId: ordering.beforeId as string | null, afterId: ordering.afterId as string | null };
  }
  if (value.tagChanges !== undefined) {
    if (!value.tagChanges || typeof value.tagChanges !== "object") return null;
    const tags = value.tagChanges as Record<string, unknown>;
    if (![tags.add, tags.remove].every((list) => Array.isArray(list) && list.length <= 100 && list.every((tag) => typeof tag === "string" && tag.length <= 100))) return null;
    operation.tagChanges = { add: tags.add as string[], remove: tags.remove as string[] };
  }
  if (value.delegationUserId !== undefined) {
    if (typeof value.delegationUserId !== "string" || !uuidPattern.test(value.delegationUserId)) return null;
    operation.delegationUserId = value.delegationUserId;
  }
  if (operation.command === "create" && !changedFields.text) return null;
  if (operation.command === "skip" && !operation.skipDate) return null;
  if (operation.command === "reorder" && !operation.ordering) return null;
  if (operation.command === "tags" && !operation.tagChanges) return null;
  if (operation.command === "delegate-assign" && !operation.delegationUserId) return null;
  if (operation.command !== "delegate-assign" && operation.delegationUserId) return null;
  return operation;
};

const reportFor = (tasks: Task[]) => {
  const completedTodosMap: Record<string, number> = {};
  const completedFrogsMap: Record<string, number> = {};
  for (const task of tasks.filter((item) => item.completedAt && !item.deletedAt)) {
    const date = task.schedule.date ?? task.completedAt?.slice(0, 10);
    if (!date) continue;
    completedTodosMap[date] = (completedTodosMap[date] ?? 0) + 1;
    if (task.frog) completedFrogsMap[date] = (completedFrogsMap[date] ?? 0) + 1;
  }
  return { completedTodosMap, completedFrogsMap, generatedAt: new Date().toISOString() };
};

export async function buildApp(options: AppOptions) {
  const production = options.production === true;
  const webOrigin = options.webOrigin?.replace(/\/$/u, "");
  if (production && (!webOrigin || new URL(webOrigin).origin !== webOrigin)) {
    throw new Error("A canonical WEB_ORIGIN is required in production");
  }
  const cookieName = production ? `__Host-${sessionCookie}` : sessionCookie;
  const app = Fastify({
    logger: options.logger
      ? {
          redact: {
            paths: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-csrf-token']", "request.headers.cookie"],
            censor: "[REDACTED]"
          }
        }
      : false,
    bodyLimit: 64 * 1024,
    trustProxy: production ? 1 : false
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      const token = request.cookies?.[cookieName];
      return token ? `session:${hashToken(token, options.sessionPepper)}` : request.ip || request.socket?.remoteAddress || "unknown-client";
    }
  });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  app.decorateRequest("authSession", null);
  const activeSockets = new Map<string, number>();
  const dummyHash = await argon2.hash("timing-equalization-password", argonOptions);

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (production && (unsafe || request.url.startsWith("/ws")) && request.headers.origin !== webOrigin) {
      return reply.code(403).send({ error: "Request origin is not allowed" });
    }
  });

  const authenticate = async (request: FastifyRequest) => {
    const token = request.cookies[cookieName];
    if (!token) return null;
    return options.store.getSession(hashToken(token, options.sessionPepper));
  };

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await authenticate(request);
    if (!session) return reply.code(401).send({ error: "Authentication required" });
    request.authSession = session;
  };

  const requireCsrf = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.authSession;
    if (!session || request.headers["x-csrf-token"] !== session.csrfToken) {
      return reply.code(403).send({ error: "Invalid request token" });
    }
  };

  const currentSession = (request: FastifyRequest): AuthenticatedSession => {
    if (!request.authSession) throw new Error("Authenticated session missing");
    return request.authSession;
  };

  const startSession = async (userId: string, reply: FastifyReply) => {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const session: SessionRecord = {
      tokenHash: hashToken(token, options.sessionPepper),
      userId,
      csrfToken,
      expiresAt: new Date(Date.now() + sessionDurationMs)
    };
    await options.store.createSession(session);
    reply.setCookie(cookieName, token, {
      httpOnly: true,
      secure: production,
      sameSite: "strict",
      path: "/",
      maxAge: sessionDurationMs / 1000
    });
    return csrfToken;
  };

  app.get("/api/health", async () => ({ ok: true }));

  app.get(
    "/api/report/public/:reportId",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { reportId } = request.params as { reportId: string };
      if (!uuidPattern.test(reportId)) return reply.code(404).send({ error: "Report not found" });
      const report = await options.store.publicReport(reportId);
      return report ?? reply.code(404).send({ error: "Report not found" });
    }
  );

  app.post(
    "/api/auth/signup",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const input = credentials(request.body);
      if (!input) return reply.code(400).send({ error: "Use a valid email and a password of at least 10 characters" });
      try {
        const passwordHash = await argon2.hash(input.password, argonOptions);
        const user = await options.store.createUser(input.email, passwordHash);
        const csrfToken = await startSession(user.id, reply);
        return reply.code(201).send({ user: { id: user.id, email: user.email }, csrfToken, settings: user.settings });
      } catch {
        return reply.code(400).send({ error: "Unable to create account with those details" });
      }
    }
  );

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const input = credentials(request.body);
      if (!input) return reply.code(401).send({ error: authError });
      const user = await options.store.findUserByEmail(input.email);
      const passwordMatches = await argon2.verify(user?.passwordHash ?? dummyHash, input.password).catch(() => false);
      if (!user || !passwordMatches) {
        return reply.code(401).send({ error: authError });
      }
      if (argon2.needsRehash(user.passwordHash, argonOptions)) {
        await options.store.updatePasswordHash(user.id, await argon2.hash(input.password, argonOptions));
      }
      const csrfToken = await startSession(user.id, reply);
      return { user: { id: user.id, email: user.email }, csrfToken, settings: user.settings };
    }
  );

  app.get("/api/auth/session", { preHandler: [requireAuth] }, async (request) => {
    const session = currentSession(request);
    return {
      user: { id: session.user.id, email: session.user.email },
      csrfToken: session.csrfToken,
      settings: session.user.settings
    };
  });

  app.post("/api/auth/logout", { preHandler: [requireAuth, requireCsrf] }, async (request, reply) => {
    const token = request.cookies[cookieName];
    if (token) await options.store.deleteSession(hashToken(token, options.sessionPepper));
    reply.clearCookie(cookieName, { path: "/", secure: production, sameSite: "strict" });
    return reply.code(204).send();
  });

  app.get("/api/snapshot", { preHandler: [requireAuth] }, async (request, reply) => {
    const query = request.query as { cursor?: string };
    const cursor = parseCursor(query.cursor);
    if (cursor === null) return reply.code(400).send({ error: "Invalid sync cursor" });
    return options.store.snapshot(currentSession(request).user.id, cursor);
  });

  app.post("/api/commands", {
    preHandler: [requireAuth, requireCsrf],
    config: { rateLimit: { max: 240, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const operation = parseOperation(request.body);
    if (!operation) return reply.code(400).send({ error: "Invalid task operation" });
    try {
      return await options.store.applyCommand(currentSession(request).user.id, operation);
    } catch (error) {
      const message = publicConflictMessage(error, "Command rejected");
      if (message === "Command rejected") request.log.error({ err: error }, message);
      return reply.code(409).send({ error: message });
    }
  });

  app.get("/api/tasks/:taskId/history", { preHandler: [requireAuth] }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const events = await options.store.history(currentSession(request).user.id, taskId);
    if (!events.length) return reply.code(404).send({ error: "Task history is not available" });
    return { events };
  });

  app.get("/api/report", { preHandler: [requireAuth] }, async (request) =>
    reportFor((await options.store.snapshot(currentSession(request).user.id, 0)).tasks)
  );

  app.post("/api/report/share", {
    preHandler: [requireAuth, requireCsrf],
    config: { rateLimit: { max: 10, timeWindow: "1 hour" } }
  }, async (request) => {
    const userId = currentSession(request).user.id;
    const data = reportFor((await options.store.snapshot(userId, 0)).tasks);
    return { id: await options.store.createReport(userId, data) };
  });

  app.get("/api/settings", { preHandler: [requireAuth] }, async (request) =>
    options.store.getSettings(currentSession(request).user.id)
  );

  const delegationOperation = (
    body: unknown,
    taskId: string,
    command: "delegate-accept" | "delegate-reject"
  ): TaskOperation | null => {
    if (!uuidPattern.test(taskId) || !body || typeof body !== "object") return null;
    const value = body as Record<string, unknown>;
    if (
      typeof value.operationId !== "string" || !uuidPattern.test(value.operationId) ||
      typeof value.baseRevision !== "number" || !Number.isInteger(value.baseRevision) || value.baseRevision < 1
    ) return null;
    return {
      operationId: value.operationId,
      taskId,
      deviceId: "delegation-api",
      baseRevision: value.baseRevision,
      command,
      changedFields: {},
      clientTime: new Date().toISOString()
    };
  };

  app.get("/api/delegations/invitations", { preHandler: [requireAuth] }, async (request) => ({
    invitations: await options.store.delegationInvites(currentSession(request).user.id)
  }));

  for (const response of ["accept", "reject"] as const) {
    app.post(`/api/delegations/:taskId/${response}`, { preHandler: [requireAuth, requireCsrf] }, async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const operation = delegationOperation(request.body, taskId, response === "accept" ? "delegate-accept" : "delegate-reject");
      if (!operation) return reply.code(400).send({ error: "Invalid delegation response" });
      try {
        const result = await options.store.applyCommand(currentSession(request).user.id, operation);
        return response === "reject" ? reply.code(204).send() : result;
      } catch (error) {
        const message = publicConflictMessage(error, "Delegation response rejected");
        if (message === "Delegation response rejected") request.log.error({ err: error }, message);
        return reply.code(409).send({ error: message });
      }
    });
  }

  app.post("/api/delegates/resolve", {
    preHandler: [requireAuth, requireCsrf],
    config: { rateLimit: { max: 20, timeWindow: "15 minutes" } }
  }, async (request, reply) => {
    const rawEmail = request.body && typeof request.body === "object"
      ? (request.body as Record<string, unknown>).email
      : null;
    const email = typeof rawEmail === "string" ? normalizeEmail(rawEmail) : "";
    const delegate = email ? await options.store.findUserByEmail(email) : null;
    if (!delegate || delegate.id === currentSession(request).user.id) {
      return reply.code(404).send({ error: "That delegate account is not available" });
    }
    return { userId: delegate.id };
  });

  app.patch("/api/settings", { preHandler: [requireAuth, requireCsrf] }, async (request, reply) => {
    const settings = parseSettings(request.body);
    if (!settings) return reply.code(400).send({ error: "Invalid settings" });
    return options.store.setSettings(currentSession(request).user.id, settings);
  });

  app.get("/api/export", {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 5, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    reply.header("content-disposition", 'attachment; filename="todorant-export.json"');
    return options.store.exportData(currentSession(request).user.id);
  });

  app.post("/api/import", {
    preHandler: [requireAuth, requireCsrf],
    config: { rateLimit: { max: 3, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    const session = currentSession(request);
    const legacyToken =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>).legacyToken
        : null;
    if (typeof legacyToken !== "string" || legacyToken.length < 16 || legacyToken.length > 512) {
      return reply.code(400).send({ error: "Your legacy Todorant access token is required" });
    }
    const latest = await options.store.latestImportRun(session.user.id);
    if (latest?.status === "queued" || latest?.status === "running") return reply.code(409).send(latest);
    let legacyUserId: string;
    try {
      legacyUserId = await options.importQueue.verifyOwnership(session.user.email, legacyToken);
    } catch {
      return reply.code(403).send({ error: "Legacy account ownership could not be verified" });
    }
    const run = await options.store.createImportRun(session.user.id, latest?.status === "failed" ? latest.id : null);
    await options.importQueue.enqueue(run, legacyUserId);
    return reply.code(202).send(run);
  });

  app.get("/api/import", { preHandler: [requireAuth] }, async (request) => ({
    run: await options.store.latestImportRun(currentSession(request).user.id)
  }));

  app.get(
    "/ws",
    {
      websocket: true,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      preValidation: async (request, reply) => {
        const session = await authenticate(request);
        if (!session) return reply.code(401).send({ error: "Authentication required" });
        if (activeSockets.get(session.user.id) && (activeSockets.get(session.user.id) ?? 0) >= 5) {
          return reply.code(429).send({ error: "Too many realtime connections" });
        }
        const cursor = parseCursor((request.query as { cursor?: string }).cursor);
        if (cursor === null) return reply.code(400).send({ error: "Invalid sync cursor" });
        request.authSession = session;
      }
    },
    (socket, request) => {
      const session = currentSession(request);
      const cursor = parseCursor((request.query as { cursor?: string }).cursor) ?? 0;
      activeSockets.set(session.user.id, (activeSockets.get(session.user.id) ?? 0) + 1);
      let closed = false;
      let ready = false;
      let alive = true;
      const buffered: SyncEvent[] = [];
      const heartbeat = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, 30_000);
      socket.on("pong", () => {
        alive = true;
      });
      const send = (event: SyncEvent) => {
        if (!closed && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "event", event }));
      };
      const unsubscribe = options.eventHub.subscribe(session.user.id, (event) => {
        if (ready) send(event);
        else buffered.push(event);
      });
      void options.store
        .snapshot(session.user.id, cursor)
        .then((snapshot) => {
          for (const event of snapshot.events) send(event);
          const replay = buffered
            .filter((event) => event.cursor > snapshot.cursor)
            .sort((a, b) => a.cursor - b.cursor);
          for (const event of replay) send(event);
          ready = true;
          if (!closed && socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "ready", cursor: replay.at(-1)?.cursor ?? snapshot.cursor }));
          }
        })
        .catch(() => socket.close(1011, "Snapshot unavailable"));
      socket.on("close", () => {
        closed = true;
        clearInterval(heartbeat);
        const remaining = Math.max(0, (activeSockets.get(session.user.id) ?? 1) - 1);
        if (remaining === 0) activeSockets.delete(session.user.id);
        else activeSockets.set(session.user.id, remaining);
        unsubscribe();
      });
    }
  );

  return app;
}
