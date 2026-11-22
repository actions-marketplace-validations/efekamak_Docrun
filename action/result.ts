import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { isRealPathContained, resolveContainedPath } from "../bot/lib/contract.js";
import type { AssertionResult, QuickstartRunResult, StepResult } from "../bot/lib/execute.js";
import {
  sanitizePublicExcerpt,
  type PublicSanitizeOptions,
} from "../bot/lib/public-output.js";

export const ACTION_RESULT_LIMITS = {
  MAX_STREAM_BYTES: 16_384,
  MAX_TEXT_FIELD_BYTES: 512,
  MAX_CONTRACT_NAME_BYTES: 120,
  MAX_VALIDATION_ERRORS: 50,
} as const;

export type ActionStatus = "passed" | "failed" | "invalid" | "error";

export type ActionOutputs = {
  status: ActionStatus;
  "failure-category": string;
  "first-failed-step": string;
  fingerprint: string;
  "duration-ms": string;
  "result-path": string;
};

const SAFE_RUN_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

function cleanShort(text: string, maxBytes: number, options?: PublicSanitizeOptions): string {
  return sanitizePublicExcerpt(text, maxBytes, options).text;
}

function sanitizeAssertion(
  assertion: AssertionResult,
  options?: PublicSanitizeOptions,
): AssertionResult {
  return {
    kind: assertion.kind,
    expected: cleanShort(assertion.expected, ACTION_RESULT_LIMITS.MAX_TEXT_FIELD_BYTES, options),
    observed: cleanShort(assertion.observed, ACTION_RESULT_LIMITS.MAX_TEXT_FIELD_BYTES, options),
    passed: assertion.passed,
  };
}

function sanitizeStep(step: StepResult, options?: PublicSanitizeOptions): StepResult {
  const stdout = sanitizePublicExcerpt(step.stdout, ACTION_RESULT_LIMITS.MAX_STREAM_BYTES, options);
  const stderr = sanitizePublicExcerpt(step.stderr, ACTION_RESULT_LIMITS.MAX_STREAM_BYTES, options);
  return {
    id: cleanShort(step.id, ACTION_RESULT_LIMITS.MAX_CONTRACT_NAME_BYTES, options),
    command: step.command,
    args: step.args.map((arg) =>
      cleanShort(arg, ACTION_RESULT_LIMITS.MAX_TEXT_FIELD_BYTES, options),
    ),
    status: step.status,
    failureCategory: step.failureCategory,
    exitCode: step.exitCode,
    signal: step.signal,
    durationMs: step.durationMs,
    timedOut: step.timedOut,
    assertions: step.assertions.map((assertion) => sanitizeAssertion(assertion, options)),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: step.stdoutTruncated || stdout.truncated,
    stderrTruncated: step.stderrTruncated || stderr.truncated,
  };
}

export function sanitizeRunResultForAction(
  result: QuickstartRunResult,
  options?: PublicSanitizeOptions,
): QuickstartRunResult {
  const safeRunId = SAFE_RUN_ID_REGEX.test(result.runId) ? result.runId : crypto.randomUUID();
  return {
    runId: safeRunId,
    contractName: cleanShort(
      result.contractName,
      ACTION_RESULT_LIMITS.MAX_CONTRACT_NAME_BYTES,
      options,
    ),
    schemaVersion: result.schemaVersion,
    status: result.status,
    failureCategory: result.failureCategory,
    firstFailedStepId: result.firstFailedStepId
      ? cleanShort(result.firstFailedStepId, ACTION_RESULT_LIMITS.MAX_CONTRACT_NAME_BYTES, options)
      : null,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    platform: result.platform,
    nodeVersion: result.nodeVersion,
    workspacePreserved: false,
    preservedWorkspaceDir: null,
    cleanup: {
      attempted: result.cleanup.attempted,
      succeeded: result.cleanup.succeeded,
      error: result.cleanup.error
        ? cleanShort(result.cleanup.error, ACTION_RESULT_LIMITS.MAX_TEXT_FIELD_BYTES, options)
        : null,
    },
    validationErrors: result.validationErrors
      .slice(0, ACTION_RESULT_LIMITS.MAX_VALIDATION_ERRORS)
      .map((err) => cleanShort(err, ACTION_RESULT_LIMITS.MAX_TEXT_FIELD_BYTES, options)),
    readmeDrift: {
      checked: result.readmeDrift.checked,
      ok: result.readmeDrift.ok,
      reason: result.readmeDrift.reason
        ? cleanShort(result.readmeDrift.reason, ACTION_RESULT_LIMITS.MAX_TEXT_FIELD_BYTES, options)
        : null,
      expectedCommands: result.readmeDrift.expectedCommands.map((cmd) =>
        cleanShort(cmd, ACTION_RESULT_LIMITS.MAX_TEXT_FIELD_BYTES, options),
      ),
      observedCommands: result.readmeDrift.observedCommands.map((cmd) =>
        cleanShort(cmd, ACTION_RESULT_LIMITS.MAX_TEXT_FIELD_BYTES, options),
      ),
    },
    steps: result.steps.map((step) => sanitizeStep(step, options)),
    failedAssertions: result.failedAssertions.map((assertion) =>
      sanitizeAssertion(assertion, options),
    ),
    fingerprint: result.fingerprint,
  };
}

export async function writeActionResultFile(
  runnerTempDir: string,
  sanitizedResult: QuickstartRunResult,
): Promise<string> {
  const realTempDir = await fs.realpath(runnerTempDir);
  const resultsDir = resolveContainedPath(realTempDir, "docrun");
  await fs.mkdir(resultsDir, { recursive: true, mode: 0o700 });

  const dirStat = await fs.lstat(resultsDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error("Refusing to write result into a non-directory or symlinked docrun directory.");
  }
  if (!(await isRealPathContained(realTempDir, resultsDir))) {
    throw new Error("Result directory escapes RUNNER_TEMP.");
  }

  const safeRunId = SAFE_RUN_ID_REGEX.test(sanitizedResult.runId)
    ? sanitizedResult.runId
    : crypto.randomUUID();
  const targetPath = resolveContainedPath(resultsDir, `${safeRunId}.json`);
  const serialized = `${JSON.stringify(sanitizedResult, null, 2)}\n`;

  await fs.writeFile(targetPath, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  return targetPath;
}

export function buildActionOutputs(
  result: Pick<
    QuickstartRunResult,
    "status" | "failureCategory" | "firstFailedStepId" | "fingerprint" | "durationMs"
  >,
  resultPath: string,
): ActionOutputs {
  return {
    status: result.status,
    "failure-category": result.failureCategory ?? "",
    "first-failed-step": result.firstFailedStepId ?? "",
    fingerprint: result.fingerprint ?? "",
    "duration-ms": String(Math.max(0, Math.round(result.durationMs))),
    "result-path": resultPath,
  };
}

export function buildWrapperErrorOutputs(): ActionOutputs {
  return {
    status: "error",
    "failure-category": "internal_error",
    "first-failed-step": "",
    fingerprint: "",
    "duration-ms": "0",
    "result-path": "",
  };
}
