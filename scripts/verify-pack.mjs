import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const requiredFiles = [...new Set([
  manifest.main,
  manifest.types,
  ...Object.values(manifest.exports ?? {}).flatMap((entry) => [entry.import, entry.types]),
].filter(Boolean).map((file) => file.replace(/^\.\//, "")))];

if (requiredFiles.length !== 20) {
  throw new Error(`Expected 20 JS/type export targets, found ${requiredFiles.length}`);
}

for (const file of requiredFiles) {
  if (!file.startsWith("dist/")) {
    throw new Error(`Package export must resolve under dist/: ${file}`);
  }
  if (!existsSync(file)) {
    throw new Error(`Missing npm package entrypoint: ${file}`);
  }
}

const pack = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
}));
const packed = new Set(pack[0]?.files?.map((file) => file.path) ?? []);

for (const file of requiredFiles) {
  if (!packed.has(file)) {
    throw new Error(`npm package would omit required file: ${file}`);
  }
}

console.log(`npm pack verification passed (${requiredFiles.length} export targets, ${packed.size} files).`);
