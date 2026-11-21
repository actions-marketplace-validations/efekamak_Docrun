import * as fs from "node:fs/promises";
import * as path from "node:path";
import { generateBadges, writeBadges } from "./badges.js";
import { loadAndValidateCatalog } from "./catalog-lib.js";
import { getArgValue, resolveSourceCommit } from "./cli-utils.js";
import { DEFAULT_HISTORY_URL, fetchPreviousHistory, mergeHistory } from "./history.js";
import { loadPlatformArtifact, mergePlatformRuns } from "./merge-platform-results.js";

const repoRoot = process.cwd();
const catalogRelPath = getArgValue("--catalog=") ?? "catalog/targets.json";
const ubuntuArg = getArgValue("--ubuntu=");
const windowsArg = getArgValue("--windows=");
const ubuntuJobResult = getArgValue("--ubuntu-job-result=") ?? null;
const windowsJobResult = getArgValue("--windows-job-result=") ?? null;
const historyUrl = getArgValue("--history-url=") ?? DEFAULT_HISTORY_URL;
const skipHistoryFetch = process.argv.includes("--no-history-fetch");
const outDir = path.resolve(repoRoot, getArgValue("--out-dir=") ?? "generated");

const validation = await loadAndValidateCatalog(repoRoot, catalogRelPath);
if (!validation.ok) {
  console.error(`Catalog validation failed:\n${validation.errors.join("\n")}`);
  process.exit(1);
}

const ubuntuPath = ubuntuArg ? path.resolve(repoRoot, ubuntuArg) : null;
const windowsPath = windowsArg ? path.resolve(repoRoot, windowsArg) : null;

const [ubuntuOutcome, windowsOutcome] = await Promise.all([
  loadPlatformArtifact(ubuntuPath, "ubuntu", { jobResult: ubuntuJobResult }),
  loadPlatformArtifact(windowsPath, "windows", { jobResult: windowsJobResult }),
]);

if (!ubuntuOutcome.ok) {
  console.warn(`warning: ubuntu artifact fallback -> ${ubuntuOutcome.reason}`);
}
if (!windowsOutcome.ok) {
  console.warn(`warning: windows artifact fallback -> ${windowsOutcome.reason}`);
}

const statusDoc = mergePlatformRuns({
  catalog: validation.catalog,
  platforms: {
    ubuntu: ubuntuOutcome,
    windows: windowsOutcome,
  },
  sourceCommit: resolveSourceCommit(),
});

let previousHistory = null;
if (!skipHistoryFetch) {
  const historyFetch = await fetchPreviousHistory(historyUrl);
  if (historyFetch.ok) {
    previousHistory = historyFetch.history;
  } else {
    console.warn(`warning: previous history unavailable (${historyFetch.reason}); starting fresh.`);
  }
}

const historyDoc = mergeHistory(previousHistory, statusDoc);
const badges = generateBadges(statusDoc);

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(
  path.join(outDir, "status.json"),
  `${JSON.stringify(statusDoc, null, 2)}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(outDir, "history.json"),
  `${JSON.stringify(historyDoc, null, 2)}\n`,
  "utf8",
);
await writeBadges(path.join(outDir, "badges"), badges);

console.log(
  `docrun aggregate complete: overall=${statusDoc.overallStatus}, targets=${statusDoc.summary.passed}/${statusDoc.summary.targets} passed (${statusDoc.summary.failed} failed, ${statusDoc.summary.infraErrors} infra_error, ${statusDoc.summary.incomplete} incomplete), platformChecks=${statusDoc.summary.platformPassed}/${statusDoc.summary.platformChecks}, historyDays=${historyDoc.days.length}, badges=${badges.size}`,
);
