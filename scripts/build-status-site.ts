import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildStatusSite } from "./catalog-lib.js";
import { getArgValue } from "./cli-utils.js";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const repoRoot = process.cwd();
const positionalStatus = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const statusJsonPath = getArgValue("--status=")
  ? path.resolve(repoRoot, getArgValue("--status=")!)
  : positionalStatus
    ? path.resolve(repoRoot, positionalStatus)
    : path.resolve(repoRoot, "generated", "status.json");

const defaultHistoryPath = path.join(path.dirname(statusJsonPath), "history.json");
const explicitHistoryArg = getArgValue("--history=");
const historyJsonPath = explicitHistoryArg
  ? path.resolve(repoRoot, explicitHistoryArg)
  : (await exists(defaultHistoryPath))
    ? defaultHistoryPath
    : undefined;

const defaultBadgesDir = path.join(path.dirname(statusJsonPath), "badges");
const explicitBadgesArg = getArgValue("--badges=");
const badgesDir = explicitBadgesArg
  ? path.resolve(repoRoot, explicitBadgesArg)
  : (await exists(defaultBadgesDir))
    ? defaultBadgesDir
    : undefined;

const outDir = path.resolve(repoRoot, getArgValue("--out=") ?? "dist-site");

await buildStatusSite({
  siteSrcDir: path.resolve(repoRoot, "site"),
  statusJsonPath,
  historyJsonPath,
  badgesDir,
  outDir,
});

console.log(`ok: built static status site into ${outDir}`);
