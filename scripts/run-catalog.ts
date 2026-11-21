import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runCatalog } from "./catalog-lib.js";

function resolveSourceCommit(): string | null {
  const envSha = process.env.GITHUB_SHA?.trim();
  if (envSha && /^[0-9a-f]{7,40}$/i.test(envSha)) {
    return envSha.slice(0, 7);
  }
  try {
    const out = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

const targetFilterArg = process.argv.find((arg) => arg.startsWith("--targets="));
const targetIds = targetFilterArg
  ? targetFilterArg
      .slice("--targets=".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : undefined;

const outPath = path.resolve(process.cwd(), "generated", "status.json");
const doc = await runCatalog({
  baseDir: process.cwd(),
  sourceCommit: resolveSourceCommit(),
  targetIds,
});

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

console.log(
  `docrun catalog complete: ${doc.summary.passed}/${doc.summary.total} passed, ${doc.summary.failed} failed, ${doc.summary.infraErrors} infra_error, ${doc.summary.notRun} not_run`,
);
for (const target of doc.targets) {
  const ver = target.resolvedVersion ?? "unknown";
  console.log(
    `  [${target.status.toUpperCase()}] ${target.name} (${target.package}@${ver}) - ${target.durationMs}ms`,
  );
}
