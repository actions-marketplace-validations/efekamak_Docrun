import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  LIMITS,
  checkReadmeDrift,
  isRealPathContained,
  resolveContainedPath,
  type AllowedCommand,
  type FailureCategory,
  type QuickstartContract,
  type QuickstartStep,
} from "./contract.js";

export type AssertionResult = {
  kind: "exitCode" | "stdoutIncludes" | "stderrIncludes" | "filesExist";
  expected: string;
  observed: string;
  passed: boolean;
};

export type StepResult = {
  id: string;
  command: AllowedCommand;
  args: string[];
  status: "passed" | "failed" | "timed_out";
  failureCategory: FailureCategory | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  assertions: AssertionResult[];
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type QuickstartRunResult = {
  runId: string;
  contractName: string;
  schemaVersion: number;
  status: "passed" | "failed" | "invalid";
  failureCategory: FailureCategory | null;
  firstFailedStepId: string | null;
  startedAt: string;
  durationMs: number;
  platform: string;
  nodeVersion: string;
  pythonVersion?: string;
  workspacePreserved: boolean;
  preservedWorkspaceDir: string | null;
  cleanup: {
    attempted: boolean;
    succeeded: boolean;
    error: string | null;
  };
  validationErrors: string[];
  readmeDrift: {
    checked: boolean;
    ok: boolean;
    reason: string | null;
    expectedCommands: string[];
    observedCommands: string[];
  };
  steps: StepResult[];
  failedAssertions: AssertionResult[];
  fingerprint: string | null;
};

export type RunOptions = {
  preserveWorkspace?: boolean;
  maxRunTimeoutMs?: number;
  maxStreamBytes?: number;
  readmeBaseDir?: string;
  toolchain?: ToolchainMode;
};

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GH_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GH_TOKEN]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
  [/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED_NPM_TOKEN]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]"],
  [/(https?:\/\/[^/\s:@]+:)([^/\s@]+)(@)/gi, "$1[REDACTED]$3"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/gi, "$1[REDACTED]"],
  [
    /(\b(?:_authToken|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|token)\s*[:=]\s*['"]?)([^\s'"`,;]{6,})(['"]?)/gi,
    "$1[REDACTED]$3",
  ],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function sliceUtf8Safe(buf: Buffer, start: number, end: number): string {
  // Advance start past any UTF-8 continuation bytes (10xxxxxx).
  let safeStart = start;
  while (safeStart < end && (buf[safeStart] & 0xc0) === 0x80) {
    safeStart += 1;
  }
  // Pull end back if it splits a multi-byte UTF-8 sequence.
  let safeEnd = end;
  if (safeEnd > safeStart && safeEnd < buf.length) {
    let lead = safeEnd - 1;
    while (lead > safeStart && (buf[lead] & 0xc0) === 0x80) {
      lead -= 1;
    }
    const first = buf[lead];
    const seqLen =
      (first & 0x80) === 0 ? 1 : (first & 0xe0) === 0xc0 ? 2 : (first & 0xf0) === 0xe0 ? 3 : 4;
    if (lead + seqLen > safeEnd) {
      safeEnd = lead;
    }
  }
  return buf.subarray(safeStart, safeEnd).toString("utf8");
}

export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return { text, truncated: false };
  }
  const headBytes = Math.floor(maxBytes * 0.45);
  const tailBytes = Math.floor(maxBytes * 0.45);
  const omitted = buf.byteLength - headBytes - tailBytes;
  const head = sliceUtf8Safe(buf, 0, headBytes);
  const tail = sliceUtf8Safe(buf, buf.byteLength - tailBytes, buf.byteLength);
  return {
    text: `${head}\n... [truncated ${omitted} bytes] ...\n${tail}`,
    truncated: true,
  };
}

export function boundOutput(
  raw: string,
  maxBytes: number = LIMITS.MAX_STREAM_BYTES,
): { text: string; truncated: boolean } {
  const cleaned = redactSecrets(stripAnsi(raw));
  return truncateUtf8(cleaned, maxBytes);
}

export function buildMinimalEnv(
  workspaceDir?: string,
  venvDir?: string,
): NodeJS.ProcessEnv {
  const allowKeys = [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
  ];

  const env: NodeJS.ProcessEnv = {};
  for (const key of allowKeys) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }

  env.CI = "true";
  env.NO_COLOR = "1";
  env.PYTHONUTF8 = "1";
  env.PYTHONUNBUFFERED = "1";
  env.PIP_DISABLE_PIP_VERSION_CHECK = "1";
  env.PIP_NO_INPUT = "1";
  env.npm_config_update_notifier = "false";
  env.npm_config_fund = "false";
  env.npm_config_audit = "false";
  if (workspaceDir) {
    env.npm_config_cache = path.join(workspaceDir, ".npm-cache");
    env.npm_config_userconfig = path.join(workspaceDir, ".npmrc-empty");
    env.PIP_CACHE_DIR = path.join(workspaceDir, ".pip-cache");
    env.UV_CACHE_DIR = path.join(workspaceDir, ".uv-cache");
  }
  if (venvDir) {
    const venvBin =
      process.platform === "win32" ? path.join(venvDir, "Scripts") : path.join(venvDir, "bin");
    const existingPath = env.PATH ?? env.Path ?? "";
    const nextPath = existingPath.length > 0 ? `${venvBin}${path.delimiter}${existingPath}` : venvBin;
    env.VIRTUAL_ENV = venvDir;
    env.PATH = nextPath;
    if (process.platform === "win32" && env.Path !== undefined) {
      env.Path = nextPath;
    }
  }
  return env;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * "host": run steps with the Node.js binary executing docrun itself (default).
 * "path": run steps with the `node` found on PATH and the npm bundled with it,
 * so a caller-selected toolchain (for example actions/setup-node) is honored
 * even when docrun is hosted by a different Node.js runtime.
 */
export type ToolchainMode = "host" | "path";

export type Toolchain = {
  nodePath: string;
  nodeVersion: string;
  npmCliPath: string | null;
  pythonPath?: string | null;
  pythonVersion?: string | null;
  uvPath?: string | null;
};

type PythonWorkspaceEnv = {
  venvDir: string | null;
  venvPython: string | null;
  pythonVersion: string | null;
  error: string | null;
};

const NODE_VERSION_REGEX = /^v\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,32}$/;
const PYTHON_VERSION_REGEX = /^Python (\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,24})/;
const UV_VERSION_REGEX = /^uv \d+\.\d+/;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const VENV_CREATE_TIMEOUT_MS = 60_000;

// Relative PATH entries are skipped so a checked-out repository can never
// supply the node or npm that docrun executes.
function absolutePathDirs(): string[] {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const rawDir of pathEnv.split(path.delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
    if (dir.length === 0 || seen.has(dir) || !path.isAbsolute(dir)) {
      continue;
    }
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

async function findNpmCliOnPath(): Promise<string | null> {
  for (const dir of absolutePathDirs()) {
    const candidates = [
      path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
      path.resolve(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        return candidate;
      }
    }

    if (process.platform !== "win32") {
      const npmBin = path.join(dir, "npm");
      if (await fileExists(npmBin)) {
        try {
          const resolved = await fs.realpath(npmBin);
          if (resolved.endsWith(".js") && (await fileExists(resolved))) {
            return resolved;
          }
        } catch {
          // Ignore unreadable PATH entries.
        }
      }
    }
  }

  return null;
}

async function findNodeOnPath(): Promise<string | null> {
  const fileName = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of absolutePathDirs()) {
    const candidate = path.join(dir, fileName);
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) {
        continue;
      }
      if (process.platform !== "win32") {
        await fs.access(candidate, fsConstants.X_OK);
      }
      return candidate;
    } catch {
      // Not present or not executable in this PATH entry.
    }
  }
  return null;
}

async function probeNodeVersion(nodePath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let stdout = "";
    let timer: NodeJS.Timeout | undefined;
    const finish = (version: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(version);
    };

    let child;
    try {
      child = spawn(nodePath, ["--version"], {
        env: buildMinimalEnv(),
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      killProcessTree(child.pid);
      finish(null);
    }, VERSION_PROBE_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 128) {
        stdout += chunk.toString("utf8");
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const version = stdout.trim();
      finish(code === 0 && NODE_VERSION_REGEX.test(version) ? version : null);
    });
  });
}

async function findNpmCliForNode(
  nodePath: string,
  useHostNpmExecPath: boolean,
): Promise<string | null> {
  if (useHostNpmExecPath) {
    const envNpmExecPath = process.env.npm_execpath;
    if (
      envNpmExecPath &&
      envNpmExecPath.endsWith("npm-cli.js") &&
      (await fileExists(envNpmExecPath))
    ) {
      return envNpmExecPath;
    }
  }

  const nodeDirs = [path.dirname(nodePath)];
  try {
    const realNodeDir = path.dirname(await fs.realpath(nodePath));
    if (!nodeDirs.includes(realNodeDir)) {
      nodeDirs.push(realNodeDir);
    }
  } catch {
    // Fall back to the unresolved directory only.
  }

  for (const nodeDir of nodeDirs) {
    const candidates = [
      path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
      path.resolve(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return findNpmCliOnPath();
}

async function probeCommandVersion(
  execPath: string,
  args: string[],
  regex: RegExp,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let output = "";
    let timer: NodeJS.Timeout | undefined;
    const finish = (match: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(match);
    };

    let child;
    try {
      child = spawn(execPath, args, {
        env: buildMinimalEnv(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      killProcessTree(child.pid);
      finish(null);
    }, VERSION_PROBE_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      if (output.length < 256) {
        output += chunk.toString("utf8");
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const m = output.trim().match(regex);
      finish(m ? (m[1] ?? m[0]) : null);
    });
  });
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      await fs.access(candidate, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export async function findPythonOnPath(): Promise<{ path: string; version: string } | null> {
  const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
  for (const dir of absolutePathDirs()) {
    if (process.platform === "win32") {
      const normalizedDir = dir.replace(/\\/g, "/").toLowerCase();
      if (normalizedDir.endsWith("/microsoft/windowsapps")) {
        continue;
      }
    }
    for (const fileName of names) {
      const candidate = path.join(dir, fileName);
      if (!(await isExecutableFile(candidate))) {
        continue;
      }
      const version = await probeCommandVersion(candidate, ["--version"], PYTHON_VERSION_REGEX);
      if (version) {
        return { path: candidate, version };
      }
    }
  }
  return null;
}

export async function findUvOnPath(): Promise<string | null> {
  const fileName = process.platform === "win32" ? "uv.exe" : "uv";
  for (const dir of absolutePathDirs()) {
    const candidate = path.join(dir, fileName);
    if (!(await isExecutableFile(candidate))) {
      continue;
    }
    const version = await probeCommandVersion(candidate, ["--version"], UV_VERSION_REGEX);
    if (version) {
      return candidate;
    }
  }
  return null;
}

async function createPythonWorkspaceVenv(
  pythonInfo: { path: string; version: string } | null,
  workspaceDir: string,
): Promise<PythonWorkspaceEnv> {
  if (!pythonInfo) {
    return {
      venvDir: null,
      venvPython: null,
      pythonVersion: null,
      error: "Python executable was not found on PATH.",
    };
  }

  const venvDir = path.join(workspaceDir, ".venv");
  const venvPython =
    process.platform === "win32"
      ? path.join(venvDir, "Scripts", "python.exe")
      : path.join(venvDir, "bin", "python");

  const creation = await new Promise<{ ok: boolean; error: string | null }>((resolve) => {
    let settled = false;
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    const finish = (res: { ok: boolean; error: string | null }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(res);
    };

    let child;
    try {
      child = spawn(pythonInfo.path, ["-m", "venv", venvDir], {
        cwd: workspaceDir,
        env: buildMinimalEnv(workspaceDir),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    timer = setTimeout(() => {
      killProcessTree(child.pid);
      finish({ ok: false, error: `Creating Python virtual environment timed out after ${VENV_CREATE_TIMEOUT_MS}ms.` });
    }, VENV_CREATE_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (err) => finish({ ok: false, error: err.message }));
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, error: null });
      } else {
        const detail = stderr.trim();
        finish({
          ok: false,
          error: detail
            ? `Failed to create Python virtual environment (exit ${code ?? "null"}): ${detail}`
            : `Failed to create Python virtual environment (exit ${code ?? "null"}).`,
        });
      }
    });
  });

  if (!creation.ok || !(await fileExists(venvPython))) {
    return {
      venvDir: null,
      venvPython: null,
      pythonVersion: pythonInfo.version,
      error: creation.error ?? "Python virtual environment was created without a python binary.",
    };
  }

  return {
    venvDir,
    venvPython,
    pythonVersion: pythonInfo.version,
    error: null,
  };
}

export async function resolveToolchain(mode: ToolchainMode = "host"): Promise<Toolchain> {
  if (mode === "path") {
    const nodeOnPath = await findNodeOnPath();
    if (nodeOnPath) {
      const nodeVersion = await probeNodeVersion(nodeOnPath);
      if (nodeVersion) {
        return {
          nodePath: nodeOnPath,
          nodeVersion,
          npmCliPath: await findNpmCliForNode(nodeOnPath, false),
        };
      }
    }
  }

  return {
    nodePath: process.execPath,
    nodeVersion: process.version,
    npmCliPath: await findNpmCliForNode(process.execPath, true),
  };
}

export async function resolveExecutable(
  command: AllowedCommand,
  args: string[],
  toolchain?: Toolchain,
  pythonEnv?: PythonWorkspaceEnv | null,
): Promise<{ execPath: string; execArgs: string[] }> {
  const resolved = toolchain ?? (await resolveToolchain("host"));
  if (command === "node") {
    return { execPath: resolved.nodePath, execArgs: args };
  }
  if (command === "npm") {
    if (resolved.npmCliPath) {
      return { execPath: resolved.nodePath, execArgs: [resolved.npmCliPath, ...args] };
    }
    return { execPath: "npm", execArgs: args };
  }
  if (command === "python") {
    const py = pythonEnv?.venvPython ?? resolved.pythonPath ?? "python";
    return { execPath: py, execArgs: args };
  }
  if (command === "pip") {
    const py = pythonEnv?.venvPython ?? resolved.pythonPath;
    if (py) {
      return { execPath: py, execArgs: ["-m", "pip", ...args] };
    }
    return { execPath: "pip", execArgs: args };
  }
  return { execPath: resolved.uvPath ?? "uv", execArgs: args };
}

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
      });
      killer.unref();
    } catch {
      // Best-effort cleanup on Windows.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

export function computeFailureFingerprint(input: {
  contractName: string;
  firstFailedStepId: string | null;
  failureCategory: FailureCategory | null;
  exitCode: number | null;
  failedAssertions: AssertionResult[];
}): string {
  const payload = JSON.stringify({
    contractName: input.contractName,
    firstFailedStepId: input.firstFailedStepId,
    failureCategory: input.failureCategory,
    exitCode: input.exitCode,
    failedAssertions: input.failedAssertions.map((a) => ({
      kind: a.kind,
      expected: a.expected,
    })),
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

type RawSpawnResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | null;
  stdout: string;
  stderr: string;
  stdoutCapped: boolean;
  stderrCapped: boolean;
  durationMs: number;
};

class BoundedStreamCapture {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private headChunks: Buffer[] = [];
  private headBytes = 0;
  private tailChunks: Buffer[] = [];
  private tailBytes = 0;
  private totalBytes = 0;
  private _capped = false;

  constructor(maxBytes: number) {
    this.headLimit = Math.max(64, Math.floor(maxBytes * 0.45));
    this.tailLimit = Math.max(64, Math.floor(maxBytes * 0.45));
  }

  get capped(): boolean {
    return this._capped;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.totalBytes += chunk.length;

    let remainder = chunk;
    if (this.headBytes < this.headLimit) {
      const take = Math.min(this.headLimit - this.headBytes, remainder.length);
      this.headChunks.push(Buffer.from(remainder.subarray(0, take)));
      this.headBytes += take;
      remainder = remainder.subarray(take);
    }

    if (remainder.length === 0) return;

    this.tailChunks.push(Buffer.from(remainder));
    this.tailBytes += remainder.length;

    if (this.tailBytes > this.tailLimit) {
      this._capped = true;
      let overflow = this.tailBytes - this.tailLimit;
      while (overflow > 0 && this.tailChunks.length > 0) {
        const first = this.tailChunks[0];
        if (first.length <= overflow) {
          this.tailChunks.shift();
          this.tailBytes -= first.length;
          overflow -= first.length;
        } else {
          this.tailChunks[0] = Buffer.from(first.subarray(overflow));
          this.tailBytes -= overflow;
          overflow = 0;
        }
      }
    }
  }

  toString(): string {
    const headBuf = Buffer.concat(this.headChunks, this.headBytes);
    const tailBuf = Buffer.concat(this.tailChunks, this.tailBytes);
    if (!this._capped) {
      return Buffer.concat([headBuf, tailBuf]).toString("utf8");
    }
    const omitted = Math.max(0, this.totalBytes - this.headBytes - this.tailBytes);
    const head = sliceUtf8Safe(headBuf, 0, headBuf.length);
    const tail = sliceUtf8Safe(tailBuf, 0, tailBuf.length);
    return `${head}\n... [stream capped: ${omitted} bytes omitted] ...\n${tail}`;
  }
}

async function spawnStepProcess(
  step: QuickstartStep,
  cwd: string,
  timeoutMs: number,
  maxStreamBytes: number,
  toolchain: Toolchain,
  pythonEnv: PythonWorkspaceEnv | null,
): Promise<RawSpawnResult> {
  const started = Date.now();
  if ((step.command === "python" || step.command === "pip") && pythonEnv?.error) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: pythonEnv.error,
      stdout: "",
      stderr: "",
      stdoutCapped: false,
      stderrCapped: false,
      durationMs: Date.now() - started,
    };
  }
  if (step.command === "uv" && !toolchain.uvPath) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: "uv executable was not found on PATH.",
      stdout: "",
      stderr: "",
      stdoutCapped: false,
      stderrCapped: false,
      durationMs: Date.now() - started,
    };
  }
  const { execPath, execArgs } = await resolveExecutable(
    step.command,
    step.args,
    toolchain,
    pythonEnv,
  );
  const captureCap = maxStreamBytes * 4;

  return new Promise<RawSpawnResult>((resolve) => {
    const stdoutCapture = new BoundedStreamCapture(captureCap);
    const stderrCapture = new BoundedStreamCapture(captureCap);
    let timedOut = false;
    let settled = false;

    const child = spawn(execPath, execArgs, {
      cwd,
      env: buildMinimalEnv(cwd, pythonEnv?.venvDir ?? undefined),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutCapture.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrCapture.push(chunk);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        timedOut,
        spawnError: err.message,
        stdout: stdoutCapture.toString(),
        stderr: stderrCapture.toString(),
        stdoutCapped: stdoutCapture.capped,
        stderrCapped: stderrCapture.capped,
        durationMs: Date.now() - started,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        spawnError: null,
        stdout: stdoutCapture.toString(),
        stderr: stderrCapture.toString(),
        stdoutCapped: stdoutCapture.capped,
        stderrCapped: stderrCapture.capped,
        durationMs: Date.now() - started,
      });
    });
  });
}

async function evaluateStepAssertions(
  step: QuickstartStep,
  workspaceDir: string,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  results.push({
    kind: "exitCode",
    expected: String(step.expect.exitCode),
    observed: exitCode === null ? "null" : String(exitCode),
    passed: exitCode === step.expect.exitCode,
  });

  for (const needle of step.expect.stdoutIncludes ?? []) {
    const passed = stdout.includes(needle);
    results.push({
      kind: "stdoutIncludes",
      expected: needle,
      observed: passed ? "matched" : "not found in stdout",
      passed,
    });
  }

  for (const needle of step.expect.stderrIncludes ?? []) {
    const passed = stderr.includes(needle);
    results.push({
      kind: "stderrIncludes",
      expected: needle,
      observed: passed ? "matched" : "not found in stderr",
      passed,
    });
  }

  for (const relPath of step.expect.filesExist ?? []) {
    const fullPath = resolveContainedPath(workspaceDir, relPath);
    let exists = false;
    let observed = "missing";
    if (await fileExists(fullPath)) {
      if (await isRealPathContained(workspaceDir, fullPath)) {
        exists = true;
        observed = "exists";
      } else {
        observed = "symlink escapes workspace";
      }
    }
    results.push({
      kind: "filesExist",
      expected: relPath,
      observed,
      passed: exists,
    });
  }

  return results;
}

function classifyStepFailure(
  step: QuickstartStep,
  raw: RawSpawnResult,
  assertions: AssertionResult[],
): FailureCategory {
  if (raw.timedOut) {
    return "timed_out";
  }
  if (raw.spawnError !== null) {
    return "environment_failed";
  }
  const exitAssertion = assertions.find((a) => a.kind === "exitCode");
  if (exitAssertion && !exitAssertion.passed) {
    if (step.command === "npm" && (step.args[0] === "install" || step.args[0] === "i" || step.args[0] === "ci")) {
      return "install_failed";
    }
    if (step.command === "pip" && step.args[0] === "install") {
      return "install_failed";
    }
    if (
      step.command === "python" &&
      step.args[0] === "-m" &&
      step.args[1] === "pip" &&
      step.args[2] === "install"
    ) {
      return "install_failed";
    }
    if (
      step.command === "uv" &&
      (step.args[0] === "sync" ||
        step.args[0] === "add" ||
        (step.args[0] === "pip" && step.args[1] === "install"))
    ) {
      return "install_failed";
    }
    return "runtime_failed";
  }
  return "assertion_failed";
}

export function buildInvalidContractResult(
  contractPath: string,
  errors: string[],
): QuickstartRunResult {
  const safeName = redactSecrets(contractPath).slice(0, 120);
  const startedAt = new Date().toISOString();
  const fingerprint = computeFailureFingerprint({
    contractName: safeName,
    firstFailedStepId: null,
    failureCategory: "contract_invalid",
    exitCode: null,
    failedAssertions: [],
  });
  return {
    runId: crypto.randomUUID(),
    contractName: safeName,
    schemaVersion: 1,
    status: "invalid",
    failureCategory: "contract_invalid",
    firstFailedStepId: null,
    startedAt,
    durationMs: 0,
    platform: process.platform,
    nodeVersion: process.version,
    workspacePreserved: false,
    preservedWorkspaceDir: null,
    cleanup: { attempted: false, succeeded: true, error: null },
    validationErrors: errors,
    readmeDrift: {
      checked: false,
      ok: true,
      reason: null,
      expectedCommands: [],
      observedCommands: [],
    },
    steps: [],
    failedAssertions: [],
    fingerprint,
  };
}

export async function runQuickstartContract(
  contract: QuickstartContract,
  options: RunOptions = {},
): Promise<QuickstartRunResult> {
  const runId = crypto.randomUUID();
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const maxRunTimeoutMs = options.maxRunTimeoutMs ?? LIMITS.MAX_RUN_TIMEOUT_MS;
  const maxStreamBytes = options.maxStreamBytes ?? LIMITS.MAX_STREAM_BYTES;
  const preserveWorkspace = options.preserveWorkspace ?? false;

  const readmeDrift: QuickstartRunResult["readmeDrift"] = {
    checked: false,
    ok: true,
    reason: null,
    expectedCommands: [],
    observedCommands: [],
  };

  if (contract.readmePath && options.readmeBaseDir) {
    readmeDrift.checked = true;
    try {
      const readmeFull = resolveContainedPath(options.readmeBaseDir, contract.readmePath);
      if (!(await isRealPathContained(options.readmeBaseDir, readmeFull))) {
        throw new Error(`README symlink escapes base directory: "${contract.readmePath}"`);
      }
      const readmeStat = await fs.stat(readmeFull);
      if (!readmeStat.isFile()) {
        throw new Error(`README path is not a regular file: "${contract.readmePath}"`);
      }
      if (readmeStat.size > LIMITS.MAX_CONTRACT_FILE_BYTES) {
        throw new Error(
          `README "${contract.readmePath}" exceeds ${LIMITS.MAX_CONTRACT_FILE_BYTES} bytes (got ${readmeStat.size}).`,
        );
      }
      const readmeContent = await fs.readFile(readmeFull, "utf8");
      const check = checkReadmeDrift(readmeContent, contract);
      readmeDrift.ok = check.ok;
      readmeDrift.reason = check.ok ? null : check.reason;
      readmeDrift.expectedCommands = check.expectedCommands;
      readmeDrift.observedCommands = check.observedCommands;
    } catch (err) {
      readmeDrift.ok = false;
      readmeDrift.reason = `Could not read README "${contract.readmePath}": ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const toolchain = await resolveToolchain(options.toolchain ?? "host");
  const usesPython = contract.steps.some((s) => s.command === "python" || s.command === "pip");
  const usesUv = contract.steps.some((s) => s.command === "uv");
  let pythonInfo: { path: string; version: string } | null = null;
  if (usesPython) {
    pythonInfo = await findPythonOnPath();
    toolchain.pythonPath = pythonInfo?.path ?? null;
    toolchain.pythonVersion = pythonInfo?.version ?? null;
  }
  if (usesUv) {
    toolchain.uvPath = await findUvOnPath();
  }

  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-"));
  let pythonEnv: PythonWorkspaceEnv | null = null;
  const stepResults: StepResult[] = [];
  let overallStatus: "passed" | "failed" = "passed";
  let overallFailureCategory: FailureCategory | null = null;
  let firstFailedStepId: string | null = null;
  let failedAssertions: AssertionResult[] = [];
  let cleanup = { attempted: false, succeeded: true, error: null as string | null };

  try {
    for (const [relPath, content] of Object.entries(contract.files)) {
      const targetPath = resolveContainedPath(workspaceDir, relPath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");
    }

    if (usesPython) {
      pythonEnv = await createPythonWorkspaceVenv(pythonInfo, workspaceDir);
    }

    for (const step of contract.steps) {
      const elapsed = Date.now() - startedMs;
      const remainingRunMs = maxRunTimeoutMs - elapsed;
      if (remainingRunMs <= 0) {
        overallStatus = "failed";
        overallFailureCategory = "timed_out";
        firstFailedStepId = step.id;
        stepResults.push({
          id: step.id,
          command: step.command,
          args: step.args.map(redactSecrets),
          status: "timed_out",
          failureCategory: "timed_out",
          exitCode: null,
          signal: null,
          durationMs: 0,
          timedOut: true,
          assertions: [],
          stdout: "",
          stderr: "Total run timeout exceeded before step started.",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
        break;
      }

      const effectiveTimeoutMs = Math.min(step.timeoutMs, remainingRunMs);
      const raw = await spawnStepProcess(
        step,
        workspaceDir,
        effectiveTimeoutMs,
        maxStreamBytes,
        toolchain,
        pythonEnv,
      );
      const boundedStdout = boundOutput(raw.stdout, maxStreamBytes);
      const boundedStderr = boundOutput(
        raw.spawnError ? `${raw.stderr}\n${raw.spawnError}`.trim() : raw.stderr,
        maxStreamBytes,
      );

      const assertions = raw.timedOut
        ? []
        : await evaluateStepAssertions(
            step,
            workspaceDir,
            raw.exitCode,
            boundedStdout.text,
            boundedStderr.text,
          );

      const stepFailedAssertions = assertions.filter((a) => !a.passed);
      const stepPassed = !raw.timedOut && raw.spawnError === null && stepFailedAssertions.length === 0;
      const stepFailureCategory = stepPassed ? null : classifyStepFailure(step, raw, assertions);

      const stepResult: StepResult = {
        id: step.id,
        command: step.command,
        args: step.args.map(redactSecrets),
        status: raw.timedOut ? "timed_out" : stepPassed ? "passed" : "failed",
        failureCategory: stepFailureCategory,
        exitCode: raw.exitCode,
        signal: raw.signal,
        durationMs: raw.durationMs,
        timedOut: raw.timedOut,
        assertions,
        stdout: boundedStdout.text,
        stderr: boundedStderr.text,
        stdoutTruncated: raw.stdoutCapped || boundedStdout.truncated,
        stderrTruncated: raw.stderrCapped || boundedStderr.truncated,
      };

      stepResults.push(stepResult);

      if (!stepPassed) {
        overallStatus = "failed";
        overallFailureCategory = stepFailureCategory;
        firstFailedStepId = step.id;
        failedAssertions = stepFailedAssertions;
        break;
      }
    }

    if (overallStatus === "passed" && readmeDrift.checked && !readmeDrift.ok) {
      overallStatus = "failed";
      overallFailureCategory = "docs_drift";
    }
  } finally {
    if (!preserveWorkspace) {
      cleanup.attempted = true;
      try {
        await fs.rm(workspaceDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
        cleanup.succeeded = true;
      } catch (err) {
        cleanup.succeeded = false;
        cleanup.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const lastFailedStep = firstFailedStepId
    ? stepResults.find((s) => s.id === firstFailedStepId) ?? null
    : null;

  const fingerprint =
    overallStatus === "failed"
      ? computeFailureFingerprint({
          contractName: contract.name,
          firstFailedStepId,
          failureCategory: overallFailureCategory,
          exitCode: lastFailedStep?.exitCode ?? null,
          failedAssertions,
        })
      : null;

  return {
    runId,
    contractName: contract.name,
    schemaVersion: contract.schemaVersion,
    status: overallStatus,
    failureCategory: overallFailureCategory,
    firstFailedStepId,
    startedAt,
    durationMs: Date.now() - startedMs,
    platform: process.platform,
    nodeVersion: toolchain.nodeVersion,
    ...(toolchain.pythonVersion ? { pythonVersion: toolchain.pythonVersion } : {}),
    workspacePreserved: preserveWorkspace,
    preservedWorkspaceDir: preserveWorkspace ? workspaceDir : null,
    cleanup,
    validationErrors: [],
    readmeDrift,
    steps: stepResults,
    failedAssertions,
    fingerprint,
  };
}
