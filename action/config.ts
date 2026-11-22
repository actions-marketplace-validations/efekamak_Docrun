import * as fs from "node:fs/promises";
import {
  isRealPathContained,
  isSafeRelativePath,
  resolveContainedPath,
} from "../bot/lib/contract.js";

export const DEFAULT_CONTRACT_PATH = "docrun.json";
export const DEFAULT_WORKING_DIRECTORY = ".";

export type RawActionInputs = {
  contract?: string;
  workingDirectory?: string;
};

export type ActionEnv = {
  GITHUB_WORKSPACE?: string;
  RUNNER_TEMP?: string;
};

export type ResolvedActionConfig = {
  workspaceDir: string;
  workingDir: string;
  runnerTempDir: string;
  contractPath: string;
  workingDirectoryInput: string;
};

export type ResolveActionConfigResult =
  | { ok: true; config: ResolvedActionConfig }
  | {
      ok: false;
      kind: "invalid_input" | "environment_error";
      contractPath: string;
      runnerTempDir: string | null;
      workspaceDir: string | null;
      message: string;
    };

async function resolveExistingDirectory(
  rawPath: string | undefined,
  envName: string,
): Promise<{ ok: true; dir: string } | { ok: false; message: string }> {
  const trimmed = rawPath?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.includes("\0")) {
    return {
      ok: false,
      message: `Required environment variable ${envName} is missing or invalid.`,
    };
  }

  let stat;
  try {
    stat = await fs.stat(trimmed);
  } catch {
    return {
      ok: false,
      message: `Required environment directory ${envName} does not exist.`,
    };
  }

  if (!stat.isDirectory()) {
    return {
      ok: false,
      message: `Required environment path ${envName} is not a directory.`,
    };
  }

  try {
    const real = await fs.realpath(trimmed);
    return { ok: true, dir: real };
  } catch {
    return {
      ok: false,
      message: `Could not resolve real path for ${envName}.`,
    };
  }
}

function normalizeContractInput(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    return DEFAULT_CONTRACT_PATH;
  }
  // Allow common leading "./" or ".\" without weakening traversal/absolute checks.
  const stripped = trimmed.replace(/^(?:\.\/|\.\\)+/, "");
  return stripped.length > 0 ? stripped : trimmed;
}

function normalizeWorkingDirectoryInput(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0 || trimmed === "." || trimmed === "./" || trimmed === ".\\") {
    return DEFAULT_WORKING_DIRECTORY;
  }
  // Never strip leading slashes or drive prefixes; let isSafeRelativePath reject them.
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:/.test(trimmed)) {
    return trimmed;
  }
  const withoutLeadingDot = trimmed.replace(/^(?:\.\/|\.\\)+/, "");
  const withoutTrailingSlash = withoutLeadingDot.replace(/[\\/]$/, "");
  return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : DEFAULT_WORKING_DIRECTORY;
}

export async function resolveActionConfig(
  rawInputs: RawActionInputs,
  env: ActionEnv = process.env,
): Promise<ResolveActionConfigResult> {
  const contractInput = normalizeContractInput(rawInputs.contract);
  const workingDirectoryInput = normalizeWorkingDirectoryInput(rawInputs.workingDirectory);

  const workspaceResolved = await resolveExistingDirectory(
    env.GITHUB_WORKSPACE,
    "GITHUB_WORKSPACE",
  );
  if (!workspaceResolved.ok) {
    return {
      ok: false,
      kind: "environment_error",
      contractPath: contractInput,
      runnerTempDir: null,
      workspaceDir: null,
      message: workspaceResolved.message,
    };
  }

  const runnerTempResolved = await resolveExistingDirectory(env.RUNNER_TEMP, "RUNNER_TEMP");
  if (!runnerTempResolved.ok) {
    return {
      ok: false,
      kind: "environment_error",
      contractPath: contractInput,
      runnerTempDir: null,
      workspaceDir: workspaceResolved.dir,
      message: runnerTempResolved.message,
    };
  }

  const workspaceDir = workspaceResolved.dir;
  const runnerTempDir = runnerTempResolved.dir;

  if (!isSafeRelativePath(contractInput)) {
    return {
      ok: false,
      kind: "invalid_input",
      contractPath: contractInput,
      runnerTempDir,
      workspaceDir,
      message:
        "Input 'contract' must be a clean relative path inside working-directory (no .., absolute paths, drive prefixes, or null bytes).",
    };
  }

  let workingDir = workspaceDir;
  if (workingDirectoryInput !== ".") {
    if (!isSafeRelativePath(workingDirectoryInput)) {
      return {
        ok: false,
        kind: "invalid_input",
        contractPath: contractInput,
        runnerTempDir,
        workspaceDir,
        message:
          "Input 'working-directory' must be '.' or a clean relative path inside GITHUB_WORKSPACE.",
      };
    }

    let candidateDir: string;
    try {
      candidateDir = resolveContainedPath(workspaceDir, workingDirectoryInput);
    } catch {
      return {
        ok: false,
        kind: "invalid_input",
        contractPath: contractInput,
        runnerTempDir,
        workspaceDir,
        message: "Input 'working-directory' escapes GITHUB_WORKSPACE.",
      };
    }

    let stat;
    try {
      stat = await fs.stat(candidateDir);
    } catch {
      return {
        ok: false,
        kind: "invalid_input",
        contractPath: contractInput,
        runnerTempDir,
        workspaceDir,
        message: `Input 'working-directory' does not exist: "${workingDirectoryInput}".`,
      };
    }

    if (!stat.isDirectory()) {
      return {
        ok: false,
        kind: "invalid_input",
        contractPath: contractInput,
        runnerTempDir,
        workspaceDir,
        message: `Input 'working-directory' is not a directory: "${workingDirectoryInput}".`,
      };
    }

    let realCandidate: string;
    try {
      realCandidate = await fs.realpath(candidateDir);
    } catch {
      return {
        ok: false,
        kind: "invalid_input",
        contractPath: contractInput,
        runnerTempDir,
        workspaceDir,
        message: `Could not resolve 'working-directory': "${workingDirectoryInput}".`,
      };
    }

    if (realCandidate !== workspaceDir && !(await isRealPathContained(workspaceDir, realCandidate))) {
      return {
        ok: false,
        kind: "invalid_input",
        contractPath: contractInput,
        runnerTempDir,
        workspaceDir,
        message: `Input 'working-directory' symlink escapes GITHUB_WORKSPACE: "${workingDirectoryInput}".`,
      };
    }

    workingDir = realCandidate;
  }

  return {
    ok: true,
    config: {
      workspaceDir,
      workingDir,
      runnerTempDir,
      contractPath: contractInput,
      workingDirectoryInput,
    },
  };
}
