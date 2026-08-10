import { PgBoss } from "pg-boss";
import { buildApp, EventHub } from "./app.js";
import { MigrationService, MongoLegacyReader } from "./migration.js";
import { createPostgresStore } from "./postgres-store.js";
import type { ImportRun } from "./store.js";

const databaseUrl = process.env.DATABASE_URL;
const sessionPepper = process.env.SESSION_PEPPER;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!sessionPepper || sessionPepper.length < 32) throw new Error("SESSION_PEPPER must be at least 32 characters");

const hub = new EventHub();
const { store, pool } = createPostgresStore(databaseUrl, hub.publish);
const boss = new PgBoss(databaseUrl);
await boss.start();
await boss.createQueue("legacy-import");
await boss.work<{ run: ImportRun; email: string }>("legacy-import", async (jobs) => {
  for (const job of jobs) {
    const url = process.env.LEGACY_MONGO_URL;
    if (!url) {
      const failed = {
        ...job.data.run,
        status: "failed" as const,
        errors: ["Legacy import is not configured by the deployment owner"],
        completedAt: new Date().toISOString()
      };
      await store.updateImportRun(failed);
      continue;
    }
    const migration = new MigrationService(
      store,
      new MongoLegacyReader(url, process.env.LEGACY_MONGO_DATABASE ?? "todorant")
    );
    await migration.run(job.data.run, job.data.email);
  }
});

const app = await buildApp({
  store,
  eventHub: hub,
  sessionPepper,
  production: process.env.NODE_ENV === "production",
  logger: true,
  importQueue: {
    async enqueue(run, email) {
      await boss.send("legacy-import", { run, email }, { singletonKey: run.id });
    }
  }
});

const close = async () => {
  await app.close();
  await boss.stop({ graceful: true });
  await pool.end();
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());

await app.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3000)
});
