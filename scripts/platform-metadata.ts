import { spawn } from "node:child_process";
import * as os from "node:os";
import { buildMinimalEnv, resolveExecutable } from "../bot/lib/execute.js";
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

function cleanMeta(value: string, maxLen: number, fallback: string): string {
  const sanitized = sanitizePublicExcerpt(value.replace(/[\r\n\t]+/g, " ").trim(), maxLen).text.trim();
  if (sanitized.length === 0) {
    return fallback;
  }
  return sanitized.slice(0, maxLen);
}

export async function readNpmVersion(timeoutMs: number = 10_000): Promise<string> {
  try {
    const { execPath, execArgs } = await resolveExecutable("npm", ["--version"]);
    return await new Promise<string>((resolve) => {
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
          // ignore
        }
        resolve("unknown");
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < 128) {
          stdout += chunk.toString("utf8");
        }
      });

      child.on("error", () => {
        clearTimeout(timer);
        resolve("unknown");
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const trimmed = stdout.trim();
        if (code === 0 && /^[0-9]+\.[0-9]+\.[0-9A-Za-z.+-]{1,24}$/.test(trimmed)) {
          resolve(trimmed);
        } else {
          resolve("unknown");
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
    runnerImage?: string | null;
  },
): Promise<PlatformEnvironment> {
  assertPlatformMatchesHost(platform, options?.hostPlatform ?? process.platform);

  const npmVersion = options?.npmVersion ?? (await readNpmVersion());
  const rawRunnerImage =
    options?.runnerImage !== undefined
      ? options.runnerImage
      : (process.env.ImageOS?.trim() || null);
  const runnerImage = rawRunnerImage ? cleanMeta(rawRunnerImage, 64, "unknown") : null;

  const env: PlatformEnvironment = {
    osName: platform === "ubuntu" ? "Ubuntu" : "Windows",
    osVersion: cleanMeta(os.version(), 120, platform === "ubuntu" ? "Linux" : "Windows"),
    osRelease: cleanMeta(os.release(), 64, "unknown"),
    arch: cleanMeta(process.arch, 32, "unknown"),
    nodeVersion: cleanMeta(process.version, 32, "unknown"),
    npmVersion: cleanMeta(npmVersion, 32, "unknown"),
    runnerImage,
  };

  return PlatformEnvironmentSchema.parse(env);
}
