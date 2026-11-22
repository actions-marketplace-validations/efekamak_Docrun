import * as fs from "node:fs/promises";
import * as path from "node:path";

const DIST_DIR = path.resolve("dist-action");
const BUNDLE_FILE = path.join(DIST_DIR, "index.js");
const REQUIRED_FILES = ["index.js", "package.json", "licenses.txt"];

const FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "@grok/agent-sdk", pattern: /@grok\/agent-sdk/ },
  { label: "CURSOR_API_KEY", pattern: /CURSOR_API_KEY/ },
  { label: "CURSOR_SERVICE_ACCOUNT_KEY", pattern: /CURSOR_SERVICE_ACCOUNT_KEY/ },
  { label: "run_quickstart tool", pattern: /\brun_quickstart\b/ },
  { label: "defineTool", pattern: /\bdefineTool\b/ },
  { label: "defineAgent", pattern: /\bdefineAgent\b/ },
  { label: "defineArtifacts", pattern: /\bdefineArtifacts\b/ },
  { label: "sourceMappingURL", pattern: /sourceMappingURL/ },
  { label: "Windows local user path", pattern: /[A-Za-z]:\\Users\\/ },
  { label: "Unix local home path", pattern: /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\// },
];

async function main(): Promise<void> {
  const entries = await fs.readdir(DIST_DIR);
  const missing = REQUIRED_FILES.filter((file) => !entries.includes(file));
  if (missing.length > 0) {
    throw new Error(`Missing required dist-action file(s): ${missing.join(", ")}`);
  }

  const mapFiles = entries.filter((entry) => entry.endsWith(".map"));
  if (mapFiles.length > 0) {
    throw new Error(`Unexpected source map file(s) in dist-action: ${mapFiles.join(", ")}`);
  }

  const bundleContent = await fs.readFile(BUNDLE_FILE, "utf8");
  if (bundleContent.trim().length === 0) {
    throw new Error("dist-action/index.js is empty.");
  }

  const violations: string[] = [];
  for (const { label, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(bundleContent)) {
      violations.push(label);
    }
  }

  if (violations.length > 0) {
    throw new Error(`Forbidden content detected in dist-action/index.js: ${violations.join(", ")}`);
  }

  console.log(
    `Verified dist-action bundle (${Buffer.byteLength(bundleContent, "utf8")} bytes, 0 forbidden tokens).`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
