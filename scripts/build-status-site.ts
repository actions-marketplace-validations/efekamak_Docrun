import * as path from "node:path";
import { buildStatusSite } from "./catalog-lib.js";

const repoRoot = process.cwd();
const statusJsonPath = process.argv[2]
  ? path.resolve(repoRoot, process.argv[2])
  : path.resolve(repoRoot, "generated", "status.json");
const outDir = path.resolve(repoRoot, "dist-site");

await buildStatusSite({
  siteSrcDir: path.resolve(repoRoot, "site"),
  statusJsonPath,
  outDir,
});

console.log(`ok: built static status site into ${outDir}`);
