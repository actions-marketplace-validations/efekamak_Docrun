import { spawn } from "node:child_process";
import * as os from "node:os";
import { buildMinimalEnv, findPythonOnPath, resolveExecutable } from "../bot/lib/execute.js";
import { sanitizePublicExcerpt } from "./catalog-lib.js";
import {
  PlatformEnvironmentSchema,
  type PlatformEnvironment,
  type PlatformId,
} from "./status-v2.js";

export function assertPlatformMatchesHost(
  platform: PlatformId,
  hostPlatform: NodeJS.Platform = process.platform,
): void {
  if (platform === "ubuntu" && hostPlatform !== "linux") {
    throw new Error(
      `Platform label "ubuntu" requires Linux host (detected "${hostPlatform}"). Refusing to emit mislabeled artifact.`,
    );
  }
  if (platform === "windows" && hostPlatform !== "win32") {
    throw new Error(
      `Platform label "windows" requires Windows host (detected "${hostPlatform}"). Refusing to emit mislabeled artifact.`,
    );
  }
}

export function detectHostPlatformId(hostPlatform: NodeJS.Platform = process.platform): PlatformId {
  if (hostPlatform === "linux") return "ubuntu";
  if (hostPlatform === "win32") return "windows";
  throw new Error(
    `Unsupported host platform "${hostPlatform}" for live status run (expected linux or win32).`,
  );
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f]+/g;

export function cleanMetadataValue(value: string, maxLen: number, fallback: string): string {
  const collapsed = value.replace(CONTROL_CHARS_REGEX, " ").replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return fallback;
  }
  // Scrub secrets and local paths without inserting multi-line truncation markers.
  const scrubbed = sanitizePublicExcerpt(collapsed, 2048).text.trim();
  const clipped = scrubbed.length > maxLen ? scrubbed.slice(0, maxLen).trim() : scrubbed;
  return clipped.length > 0 ? clipped : fallback;
}

export async function readNpmVersion(timeoutMs: number = 10_000): Promise<string> {
  try {
    const { execPath, execArgs } = await resolveExecutable("npm", ["--version"]);
    return await new Promise<string>((resolve) => {
      let settled = false;
      const finish = (version: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(version);
      };

      const child = spawn(execPath, execArgs, {
        shell: false,
        env: buildMinimalEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      });

      let stdout = "";
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best-effort process cleanup.
        }
        finish("unknown");
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < 128) {
          stdout += chunk.toString("utf8");
        }
      });

      child.on("error", () => finish("unknown"));

      child.on("close", (code) => {
        const trimmed = stdout.trim();
        if (code === 0 && /^[0-9]+\.[0-9]+\.[0-9A-Za-z.+-]{1,24}$/.test(trimmed)) {
          finish(trimmed);
        } else {
          finish("unknown");
        }
      });
    });
  } catch {
    return "unknown";
  }
}

export async function collectPlatformEnvironment(
  platform: PlatformId,
  options?: {
    hostPlatform?: NodeJS.Platform;
    npmVersion?: string;
    pythonVersion?: string | null;
    runnerImage?: string | null;
  },
): Promise<PlatformEnvironment> {
  assertPlatformMatchesHost(platform, options?.hostPlatform ?? process.platform);

  const npmVersion = options?.npmVersion ?? (await readNpmVersion());
  const detectedPython =
    options?.pythonVersion !== undefined
      ? options.pythonVersion
      : (await findPythonOnPath())?.version ?? null;
  const rawRunnerImage =
    options?.runnerImage !== undefined
      ? options.runnerImage
      : (process.env.ImageOS?.trim() || null);
  const runnerImage = rawRunnerImage ? cleanMetadataValue(rawRunnerImage, 64, "unknown") : null;

  const env: PlatformEnvironment = {
    osName: platform === "ubuntu" ? "Ubuntu" : "Windows",
    osVersion: cleanMetadataValue(os.version(), 120, platform === "ubuntu" ? "Linux" : "Windows"),
    osRelease: cleanMetadataValue(os.release(), 64, "unknown"),
    arch: cleanMetadataValue(process.arch, 32, "unknown"),
    nodeVersion: cleanMetadataValue(process.version, 32, "unknown"),
    npmVersion: cleanMetadataValue(npmVersion, 32, "unknown"),
    ...(detectedPython ? { pythonVersion: cleanMetadataValue(detectedPython, 32, "unknown") } : {}),
    runnerImage,
  };

  return PlatformEnvironmentSchema.parse(env);
}
