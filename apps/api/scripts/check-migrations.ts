import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(import.meta.dirname, "../drizzle");
const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
if (files.length === 0) throw new Error("No SQL migrations found");

for (const file of files) {
  const sql = await readFile(resolve(directory, file), "utf8");
  if (!/\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/iu.test(sql) || /DROP\s+(TABLE|DATABASE)/iu.test(sql)) {
    throw new Error(`${file} has no schema/data changes or contains a destructive schema statement`);
  }
}

console.log(`Migration check passed (${files.length} immutable SQL files)`);
