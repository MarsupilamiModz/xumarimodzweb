#!/usr/bin/env node
// One-shot codemod: migrate `import { prisma } from "@/lib/db"` call sites to
// the per-request `getDb()` accessor needed for Cloudflare Workers + Hyperdrive.
// Safe to delete after running once and verifying `tsc --noEmit` is clean.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const files = execSync('grep -rl \'from "@/lib/db"\' src --include="*.ts*"', {
  encoding: "utf8",
  cwd: process.cwd(),
})
  .trim()
  .split("\n")
  .filter(Boolean);

let changedFiles = 0;
let changedCalls = 0;

for (const file of files) {
  const original = readFileSync(file, "utf8");
  let content = original;

  const importLineRe = /^import \{([^}]*)\} from "@\/lib\/db";$/m;
  const match = content.match(importLineRe);
  if (!match) continue;

  const specifiers = match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!specifiers.includes("prisma")) continue;

  const newSpecifiers = specifiers.map((s) => (s === "prisma" ? "getDb" : s));
  // de-dupe in case a file already imports getDb alongside prisma
  const deduped = [...new Set(newSpecifiers)];
  content = content.replace(importLineRe, `import { ${deduped.join(", ")} } from "@/lib/db";`);

  const before = content;
  content = content.replace(/\bprisma\./g, "(await getDb()).");
  const callCount = (before.match(/\bprisma\./g) || []).length;
  changedCalls += callCount;

  if (content !== original) {
    writeFileSync(file, content, "utf8");
    changedFiles++;
  }
}

console.log(`Updated ${changedFiles} files, ${changedCalls} call sites.`);
