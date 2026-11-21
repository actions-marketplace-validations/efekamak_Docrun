import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runPlatformCatalog } from "./catalog-lib.js";
import { detectHostPlatformId } from "./platform-metadata.js";
import { PlatformIdSchema, type PlatformId } from "./status-v2.js";

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

function getArgValue(prefix: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

const platformArg = getArgValue("--platform=");
const platform: PlatformId = platformArg
  ? PlatformIdSchema.parse(platformArg)
  : detectHostPlatformId();

const targetFilterArg = getArgValue("--targets=");
const targetIds = targetFilterArg
  ? targetFilterArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : undefined;

const outArg = getArgValue("--out=");
const outPath = outArg
  ? path.resolve(process.cwd(), outArg)
  : path.resolve(process.cwd(), "generated", `platform-${platform}.json`);

const concurrencyArg = getArgValue("--concurrency=");
const parsedConcurrency = concurrencyArg ? Number.parseInt(concurrencyArg, 10) : undefined;
const defaultConcurrency = platform === "windows" ? 1 : 2;
const concurrency =
  parsedConcurrency !== undefined && Number.isInteger(parsedConcurrency) && parsedConcurrency >= 1
    ? parsedConcurrency
    : defaultConcurrency;

const doc = await runPlatformCatalog({
  baseDir: process.cwd(),
  platform,
  sourceCommit: resolveSourceCommit(),
  targetIds,
  concurrency,
});

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

console.log(
  `docrun [${platform}] complete (${doc.environment.osName} ${doc.environment.osRelease}, node ${doc.environment.nodeVersion}, npm ${doc.environment.npmVersion}): ${doc.summary.passed}/${doc.summary.total} passed, ${doc.summary.failed} failed, ${doc.summary.infraErrors} infra_error, ${doc.summary.notRun} not_run`,
);
for (const target of doc.targets) {
  const ver = target.resolvedVersion ?? "unknown";
  console.log(
    `  [${target.status.toUpperCase()}] ${target.id} (${ver}) - ${target.durationMs}ms`,
  );
}
