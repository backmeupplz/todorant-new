import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const assets = resolve(import.meta.dirname, "../dist/assets");
const files = (await readdir(assets)).filter((file) => file.endsWith(".js"));
if (files.length === 0) throw new Error("No production JavaScript bundle found; run build first");
const sizes = await Promise.all(
  files.map(async (file) => ({ file, bytes: gzipSync(await readFile(resolve(assets, file))).byteLength }))
);
const total = sizes.reduce((sum, entry) => sum + entry.bytes, 0);
const limit = 45 * 1024;
console.log(`${sizes.map(({ file, bytes }) => `${file}: ${bytes} B gzip`).join("\n")}\nInitial JS: ${total} / ${limit} B gzip`);
if (total > limit) throw new Error(`Initial JavaScript exceeds the 45 KB gzip budget by ${total - limit} bytes`);
