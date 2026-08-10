import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, describe, expect, it } from "vitest";

const adminUrl = process.env.TEST_DATABASE_URL;
const runtimeUrl = process.env.TEST_RUNTIME_DATABASE_URL;
const bossUrl = process.env.TEST_BOSS_DATABASE_URL;
const suite = adminUrl && runtimeUrl && bossUrl ? describe : describe.skip;

suite("least-privilege PostgreSQL roles", () => {
  const admin = new Pool({ connectionString: adminUrl });
  const runtime = new Pool({ connectionString: runtimeUrl });
  const boss = new Pool({ connectionString: bossUrl });

  afterAll(async () => Promise.all([admin.end(), runtime.end(), boss.end()]));

  it("allows application CRUD but denies application DDL and role escalation", async () => {
    expect((await runtime.query("select count(*)::int as count from users")).rows[0]?.count).toBeTypeOf("number");
    await expect(runtime.query("create table public.security_probe(id integer)")).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query("create role security_probe")).rejects.toMatchObject({ code: "42501" });
  });

  it("isolates pg-boss ownership from application data", async () => {
    const queue = new PgBoss({ connectionString: bossUrl as string, schema: "pgboss", createSchema: false });
    await queue.start();
    await queue.createQueue("security-probe");
    expect(await queue.send("security-probe", { ok: true })).toBeTypeOf("string");
    await queue.stop({ graceful: true });
    await expect(boss.query("select * from public.users")).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps both login roles non-privileged", async () => {
    const roles = await admin.query<{
      rolname: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      "select rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls " +
        "from pg_roles where rolname in ('todorant_runtime', 'todorant_boss') order by rolname"
    );
    expect(roles.rows).toHaveLength(2);
    for (const role of roles.rows) {
      expect(role).toMatchObject({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false
      });
    }
    const owners = await admin.query<{ owner: string }>(
      "select r.rolname as owner from pg_type t join pg_namespace n on n.oid = t.typnamespace " +
        "join pg_roles r on r.oid = t.typowner where n.nspname = 'pgboss' and t.typtype = 'e'"
    );
    expect(owners.rows.length).toBeGreaterThan(0);
    expect(new Set(owners.rows.map((row) => row.owner))).toEqual(new Set(["todorant_boss"]));
  });
});
