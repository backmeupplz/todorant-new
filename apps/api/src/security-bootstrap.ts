import { Pool } from "pg";

const adminUrl = process.env.MIGRATION_DATABASE_URL;
const runtimePassword = process.env.DATABASE_RUNTIME_PASSWORD;
const bossPassword = process.env.DATABASE_BOSS_PASSWORD;

if (!adminUrl || !runtimePassword || !bossPassword) {
  throw new Error("MIGRATION_DATABASE_URL, DATABASE_RUNTIME_PASSWORD, and DATABASE_BOSS_PASSWORD are required");
}
if (runtimePassword.length < 32 || bossPassword.length < 32) {
  throw new Error("Database role passwords must be at least 32 characters");
}

const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const runtimeRole = "todorant_runtime";
const bossRole = "todorant_boss";
const pool = new Pool({ connectionString: adminUrl, max: 1 });

const ensureRole = async (name: string, password: string): Promise<void> => {
  const exists = await pool.query<{ exists: boolean }>(
    "select exists(select 1 from pg_roles where rolname = $1) as exists",
    [name]
  );
  if (exists.rows[0]?.exists) {
    await pool.query(`alter role ${identifier(name)} login password ${literal(password)}`);
  } else {
    await pool.query(`create role ${identifier(name)} login password ${literal(password)}`);
  }
  await pool.query(
    `alter role ${identifier(name)} nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`
  );
};

try {
  const identity = await pool.query<{ database: string; administrator: string }>(
    "select current_database() as database, current_user as administrator"
  );
  const database = identity.rows[0]?.database;
  const administrator = identity.rows[0]?.administrator;
  if (!database || !administrator) throw new Error("Unable to determine the migration database identity");

  await ensureRole(runtimeRole, runtimePassword);
  await ensureRole(bossRole, bossPassword);

  await pool.query(`revoke connect, temporary on database ${identifier(database)} from public`);
  await pool.query(`grant connect on database ${identifier(database)} to ${identifier(runtimeRole)}, ${identifier(bossRole)}`);
  await pool.query("revoke create on schema public from public");
  await pool.query(`grant usage on schema public to ${identifier(runtimeRole)}`);
  await pool.query(`grant select, insert, update, delete on all tables in schema public to ${identifier(runtimeRole)}`);
  await pool.query(`grant usage, select on all sequences in schema public to ${identifier(runtimeRole)}`);
  await pool.query(
    `alter default privileges for role ${identifier(administrator)} in schema public ` +
      `grant select, insert, update, delete on tables to ${identifier(runtimeRole)}`
  );
  await pool.query(
    `alter default privileges for role ${identifier(administrator)} in schema public ` +
      `grant usage, select on sequences to ${identifier(runtimeRole)}`
  );

  await pool.query(`create schema if not exists pgboss authorization ${identifier(bossRole)}`);
  await pool.query(`alter schema pgboss owner to ${identifier(bossRole)}`);
  const relations = await pool.query<{ name: string; kind: string }>(
    "select c.relname as name, c.relkind as kind from pg_class c join pg_namespace n on n.oid = c.relnamespace " +
      "where n.nspname = 'pgboss' and c.relkind in ('r', 'p', 'S')"
  );
  for (const relation of relations.rows) {
    const objectType = relation.kind === "S" ? "sequence" : "table";
    await pool.query(
      `alter ${objectType} ${identifier("pgboss")}.${identifier(relation.name)} owner to ${identifier(bossRole)}`
    );
  }
  const functions = await pool.query<{ name: string; arguments: string }>(
    "select p.proname as name, pg_get_function_identity_arguments(p.oid) as arguments " +
      "from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'pgboss'"
  );
  for (const fn of functions.rows) {
    await pool.query(
      `alter function ${identifier("pgboss")}.${identifier(fn.name)}(${fn.arguments}) owner to ${identifier(bossRole)}`
    );
  }
  process.stdout.write("Database security roles and grants are current.\n");
} finally {
  await pool.end();
}
