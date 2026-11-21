import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
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

export function buildMinimalEnv(workspaceDir?: string): NodeJS.ProcessEnv {
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
  env.npm_config_update_notifier = "false";
  env.npm_config_fund = "false";
  env.npm_config_audit = "false";
  if (workspaceDir) {
    env.npm_config_cache = path.join(workspaceDir, ".npm-cache");
    env.npm_config_userconfig = path.join(workspaceDir, ".npmrc-empty");
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

export async function resolveExecutable(
  command: AllowedCommand,
  args: string[],
): Promise<{ execPath: string; execArgs: string[] }> {
  if (command === "node") {
    return { execPath: process.execPath, execArgs: args };
  }

  const envNpmExecPath = process.env.npm_execpath;
  if (envNpmExecPath && envNpmExecPath.endsWith("npm-cli.js") && (await fileExists(envNpmExecPath))) {
    return { execPath: process.execPath, execArgs: [envNpmExecPath, ...args] };
  }

  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return { execPath: process.execPath, execArgs: [candidate, ...args] };
    }
  }

  return { execPath: "npm", execArgs: args };
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
): Promise<RawSpawnResult> {
  const started = Date.now();
  const { execPath, execArgs } = await resolveExecutable(step.command, step.args);
  const captureCap = maxStreamBytes * 4;

  return new Promise<RawSpawnResult>((resolve) => {
    const stdoutCapture = new BoundedStreamCapture(captureCap);
    const stderrCapture = new BoundedStreamCapture(captureCap);
    let timedOut = false;
    let settled = false;

    const child = spawn(execPath, execArgs, {
      cwd,
      env: buildMinimalEnv(cwd),
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

  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-"));
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
      const raw = await spawnStepProcess(step, workspaceDir, effectiveTimeoutMs, maxStreamBytes);
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
    nodeVersion: process.version,
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
