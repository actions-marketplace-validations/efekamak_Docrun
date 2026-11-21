import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runPlatformCatalog } from "./catalog-lib.js";
import { getArgValue, resolveSourceCommit } from "./cli-utils.js";
import { detectHostPlatformId } from "./platform-metadata.js";
import { PlatformIdSchema, type PlatformId } from "./status-v2.js";

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
const defaultConcurrency = platform === "windows" ? 1 : 2;
let concurrency = defaultConcurrency;
if (concurrencyArg !== undefined) {
  if (!/^[1-9]\d*$/.test(concurrencyArg)) {
    throw new Error(`Invalid --concurrency value: "${concurrencyArg}" (expected positive integer).`);
  }
  concurrency = Number.parseInt(concurrencyArg, 10);
}

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
