import { execFileSync } from "node:child_process";

export function getArgValue(prefix: string, argv: string[] = process.argv): string | undefined {
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

export function resolveSourceCommit(): string | null {
  const envSha = process.env.GITHUB_SHA?.trim();
  if (envSha && /^[0-9a-f]{7,40}$/i.test(envSha)) {
    return envSha.slice(0, 7);
  }
  try {
    const out = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return /^[0-9a-f]{7,40}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}
