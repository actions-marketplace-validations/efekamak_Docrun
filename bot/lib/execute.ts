import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  LIMITS,
  checkReadmeDrift,
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

export function boundOutput(
  raw: string,
  maxBytes: number = LIMITS.MAX_STREAM_BYTES,
): { text: string; truncated: boolean } {
  const cleaned = redactSecrets(stripAnsi(raw));
  const buf = Buffer.from(cleaned, "utf8");
  if (buf.byteLength <= maxBytes) {
    return { text: cleaned, truncated: false };
  }

  const headBytes = Math.floor(maxBytes * 0.45);
  const tailBytes = Math.floor(maxBytes * 0.45);
  const omitted = buf.byteLength - headBytes - tailBytes;
  const head = buf.subarray(0, headBytes).toString("utf8");
  const tail = buf.subarray(buf.byteLength - tailBytes).toString("utf8");
  return {
    text: `${head}\n... [truncated ${omitted} bytes] ...\n${tail}`,
    truncated: true,
  };
}

export function buildMinimalEnv(): NodeJS.ProcessEnv {
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

async function resolveExecutable(
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
    let stdout = "";
    let stderr = "";
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(execPath, execArgs, {
      cwd,
      env: buildMinimalEnv(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    const appendBounded = (
      current: string,
      chunk: Buffer,
    ): { text: string; capped: boolean } => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") <= captureCap) {
        return { text: next, capped: false };
      }
      const headLen = Math.floor(captureCap * 0.45);
      const tailLen = Math.floor(captureCap * 0.45);
      const buf = Buffer.from(next, "utf8");
      return {
        text:
          buf.subarray(0, headLen).toString("utf8") +
          "\n... [stream capped during capture] ...\n" +
          buf.subarray(buf.byteLength - tailLen).toString("utf8"),
        capped: true,
      };
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const res = appendBounded(stdout, chunk);
      stdout = res.text;
      if (res.capped) stdoutCapped = true;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const res = appendBounded(stderr, chunk);
      stderr = res.text;
      if (res.capped) stderrCapped = true;
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
        stdout,
        stderr,
        stdoutCapped,
        stderrCapped,
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
        stdout,
        stderr,
        stdoutCapped,
        stderrCapped,
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
      const [realWorkspace, realTarget] = await Promise.all([
        fs.realpath(workspaceDir),
        fs.realpath(fullPath),
      ]);
      const rel = path.relative(realWorkspace, realTarget);
      if (!rel.startsWith("..") && !path.isAbsolute(rel) && rel !== "") {
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
