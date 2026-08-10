import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { normalizeEmail, type SyncEvent, type TaskOperation } from "@todorant/domain";
import type { DataStore, ImportRun, SessionRecord } from "./store.js";

const sessionCookie = "todorant_session";
const sessionDurationMs = 1000 * 60 * 60 * 24 * 30;
const authError = "Email or password is incorrect";
const argonOptions = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type AuthenticatedSession = SessionRecord & {
  user: { id: string; email: string; settings: Record<string, unknown> };
};

declare module "fastify" {
  interface FastifyRequest {
    authSession: AuthenticatedSession | null;
  }
}

export type ImportQueue = {
  enqueue(run: ImportRun, email: string): Promise<void>;
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
};

const hashToken = (token: string, pepper: string): string =>
  createHash("sha256").update(`${pepper}:${token}`).digest("hex");

const credentials = (body: unknown): { email: string; password: string } | null => {
  if (!body || typeof body !== "object") return null;
  const input = body as Record<string, unknown>;
  if (typeof input.email !== "string" || typeof input.password !== "string") return null;
  const email = normalizeEmail(input.email);
  if (!/^\S+@\S+\.\S+$/u.test(email) || input.password.length < 10 || input.password.length > 256) return null;
  return { email, password: input.password };
};

const parseOperation = (body: unknown): TaskOperation | null => {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const commands = ["create", "update", "complete", "reopen", "skip", "delete", "restore", "reorder", "tags"] as const;
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
  const allowedFields = new Set(["text", "note", "frog", "epicId", "delegateId", "schedule", "repeat", "encryption"]);
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
  for (const key of ["epicId", "delegateId"] as const) {
    if (source[key] !== undefined) {
      if (source[key] !== null && (typeof source[key] !== "string" || String(source[key]).length > 128)) return null;
      changedFields[key] = source[key] as string | null;
    }
  }
  if (source.schedule !== undefined) {
    if (!source.schedule || typeof source.schedule !== "object") return null;
    const schedule = source.schedule as Record<string, unknown>;
    if (![schedule.date, schedule.time, schedule.timezone].every((entry) => entry === null || typeof entry === "string")) return null;
    changedFields.schedule = {
      date: schedule.date as string | null,
      time: schedule.time as string | null,
      timezone: schedule.timezone as string | null
    };
  }
  if (source.repeat !== undefined) {
    if (source.repeat === null) changedFields.repeat = null;
    else {
      if (!source.repeat || typeof source.repeat !== "object") return null;
      const repeat = source.repeat as Record<string, unknown>;
      if (
        typeof repeat.cadence !== "string" ||
        !["daily", "weekly", "monthly", "custom"].includes(repeat.cadence) ||
        typeof repeat.interval !== "number" ||
        !Number.isInteger(repeat.interval) ||
        repeat.interval < 1
      ) return null;
      changedFields.repeat = {
        cadence: repeat.cadence as "daily" | "weekly" | "monthly" | "custom",
        interval: repeat.interval
      };
    }
  }
  if (source.encryption !== undefined) {
    if (source.encryption === null) changedFields.encryption = null;
    else {
      if (!source.encryption || typeof source.encryption !== "object") return null;
      const encryption = source.encryption as Record<string, unknown>;
      if (typeof encryption.algorithm !== "string" || typeof encryption.keyId !== "string") return null;
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
    clientTime: typeof value.clientTime === "string" ? value.clientTime : new Date().toISOString()
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
  if (operation.command === "create" && !changedFields.text) return null;
  if (operation.command === "skip" && !operation.skipDate) return null;
  if (operation.command === "reorder" && !operation.ordering) return null;
  if (operation.command === "tags" && !operation.tagChanges) return null;
  return operation;
};

export async function buildApp(options: AppOptions) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024,
    trustProxy: options.production === true
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false, max: 100, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  app.decorateRequest("authSession", null);
  const dummyHash = await argon2.hash("timing-equalization-password", argonOptions);

  const authenticate = async (request: FastifyRequest) => {
    const token = request.cookies[sessionCookie];
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
    reply.setCookie(sessionCookie, token, {
      httpOnly: true,
      secure: options.production === true,
      sameSite: "strict",
      path: "/",
      maxAge: sessionDurationMs / 1000
    });
    return csrfToken;
  };

  app.get("/api/health", async () => ({ ok: true }));

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
        return reply.code(201).send({ user: { id: user.id, email: user.email }, csrfToken });
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
      const csrfToken = await startSession(user.id, reply);
      return { user: { id: user.id, email: user.email }, csrfToken };
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
    const token = request.cookies[sessionCookie];
    if (token) await options.store.deleteSession(hashToken(token, options.sessionPepper));
    reply.clearCookie(sessionCookie, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/snapshot", { preHandler: [requireAuth] }, async (request) => {
    const query = request.query as { cursor?: string };
    const cursor = Math.max(0, Number(query.cursor ?? 0) || 0);
    return options.store.snapshot(currentSession(request).user.id, cursor);
  });

  app.post("/api/commands", { preHandler: [requireAuth, requireCsrf] }, async (request, reply) => {
    const operation = parseOperation(request.body);
    if (!operation) return reply.code(400).send({ error: "Invalid task operation" });
    try {
      return await options.store.applyCommand(currentSession(request).user.id, operation);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Command rejected" });
    }
  });

  app.get("/api/tasks/:taskId/history", { preHandler: [requireAuth] }, async (request) => {
    const { taskId } = request.params as { taskId: string };
    return { events: await options.store.history(currentSession(request).user.id, taskId) };
  });

  app.get("/api/settings", { preHandler: [requireAuth] }, async (request) =>
    options.store.getSettings(currentSession(request).user.id)
  );

  app.patch("/api/settings", { preHandler: [requireAuth, requireCsrf] }, async (request, reply) => {
    if (!request.body || typeof request.body !== "object") return reply.code(400).send({ error: "Invalid settings" });
    return options.store.setSettings(currentSession(request).user.id, request.body as Record<string, unknown>);
  });

  app.get("/api/export", { preHandler: [requireAuth] }, async (request, reply) => {
    reply.header("content-disposition", 'attachment; filename="todorant-export.json"');
    return options.store.exportData(currentSession(request).user.id);
  });

  app.post("/api/import", { preHandler: [requireAuth, requireCsrf] }, async (request, reply) => {
    const session = currentSession(request);
    const latest = await options.store.latestImportRun(session.user.id);
    if (latest?.status === "queued" || latest?.status === "running") return reply.code(409).send(latest);
    const run = await options.store.createImportRun(session.user.id, latest?.status === "failed" ? latest.id : null);
    await options.importQueue.enqueue(run, session.user.email);
    return reply.code(202).send(run);
  });

  app.get("/api/import", { preHandler: [requireAuth] }, async (request) => ({
    run: await options.store.latestImportRun(currentSession(request).user.id)
  }));

  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const session = await authenticate(request);
        if (!session) return reply.code(401).send({ error: "Authentication required" });
        request.authSession = session;
      }
    },
    (socket, request) => {
      const session = currentSession(request);
      const cursor = Math.max(0, Number((request.query as { cursor?: string }).cursor ?? 0) || 0);
      let closed = false;
      let ready = false;
      const buffered: SyncEvent[] = [];
      const send = (event: SyncEvent) => {
        if (!closed && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "event", event }));
      };
      const unsubscribe = options.eventHub.subscribe(session.user.id, (event) => {
        if (ready) send(event);
        else buffered.push(event);
      });
      void options.store.snapshot(session.user.id, cursor).then((snapshot) => {
        for (const event of snapshot.events) send(event);
        for (const event of buffered.filter((event) => event.cursor > snapshot.cursor).sort((a, b) => a.cursor - b.cursor)) send(event);
        ready = true;
        if (!closed && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "ready", cursor: snapshot.cursor }));
        }
      });
      socket.on("close", () => {
        closed = true;
        unsubscribe();
      });
    }
  );

  return app;
}
