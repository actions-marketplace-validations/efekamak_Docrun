import { loadContractFile, type QuickstartStep } from "../bot/lib/contract.js";
import {
  buildInvalidContractResult,
  runQuickstartContract,
  type QuickstartRunResult,
} from "../bot/lib/execute.js";
import type { PublicSanitizeOptions } from "../bot/lib/public-output.js";
import {
  resolveActionConfig,
  type ActionEnv,
  type RawActionInputs,
} from "./config.js";
import {
  buildActionOutputs,
  buildWrapperErrorOutputs,
  sanitizeRunResultForAction,
  writeActionResultFile,
  type ActionOutputs,
} from "./result.js";
import { escapeHtml, renderStepSummary } from "./summary.js";

export type ActionExecutionOutcome =
  | {
      ok: true;
      result: QuickstartRunResult;
      outputs: ActionOutputs;
      summaryHtml: string;
      failureMessage: string | null;
    }
  | {
      ok: false;
      outputs: ActionOutputs;
      summaryHtml: string;
      failureMessage: string;
    };

function buildSanitizeOptions(paths: {
  workspaceDir?: string | null;
  workingDir?: string | null;
  runnerTempDir?: string | null;
}): PublicSanitizeOptions {
  const extraPathReplacements: Array<{ path: string; replacement: string }> = [];
  if (paths.workingDir && paths.workingDir !== paths.workspaceDir) {
    extraPathReplacements.push({ path: paths.workingDir, replacement: "<working-directory>" });
  }
  if (paths.workspaceDir) {
    extraPathReplacements.push({ path: paths.workspaceDir, replacement: "<workspace>" });
  }
  if (paths.runnerTempDir) {
    extraPathReplacements.push({ path: paths.runnerTempDir, replacement: "<runner-temp>" });
  }
  return { extraPathReplacements };
}

function buildFailureMessage(result: QuickstartRunResult): string | null {
  if (result.status === "passed") {
    return null;
  }
  if (result.status === "invalid") {
    return `docrun contract is invalid (${result.contractName}).`;
  }
  const category = result.failureCategory ?? "failed";
  const stepSuffix = result.firstFailedStepId ? ` at step "${result.firstFailedStepId}"` : "";
  return `docrun quickstart failed (${category})${stepSuffix}.`;
}

export async function executeDocrunAction(
  rawInputs: RawActionInputs,
  env: ActionEnv = process.env,
): Promise<ActionExecutionOutcome> {
  const resolved = await resolveActionConfig(rawInputs, env);

  if (!resolved.ok) {
    if (resolved.kind === "invalid_input" && resolved.runnerTempDir) {
      const sanitizeOptions = buildSanitizeOptions({
        workspaceDir: resolved.workspaceDir,
        runnerTempDir: resolved.runnerTempDir,
      });
      const rawInvalid = buildInvalidContractResult(resolved.contractPath, [resolved.message]);
      const sanitized = sanitizeRunResultForAction(rawInvalid, sanitizeOptions);
      const resultPath = await writeActionResultFile(resolved.runnerTempDir, sanitized);
      const summaryHtml = renderStepSummary(sanitized, {
        contractPath: sanitized.contractName,
        sanitizeOptions,
      });
      return {
        ok: true,
        result: sanitized,
        outputs: buildActionOutputs(sanitized, resultPath),
        summaryHtml,
        failureMessage: buildFailureMessage(sanitized),
      };
    }

    const safeMessage = resolved.message;
    return {
      ok: false,
      outputs: buildWrapperErrorOutputs(),
      summaryHtml: `<h3>docrun: error</h3>\n<p>${escapeHtml(safeMessage)}</p>\n`,
      failureMessage: safeMessage,
    };
  }

  const { config } = resolved;
  const sanitizeOptions = buildSanitizeOptions({
    workspaceDir: config.workspaceDir,
    workingDir: config.workingDir,
    runnerTempDir: config.runnerTempDir,
  });

  const loaded = await loadContractFile(config.workingDir, config.contractPath);
  let rawResult: QuickstartRunResult;
  let declaredSteps: QuickstartStep[] | undefined;

  if (loaded.ok) {
    declaredSteps = loaded.contract.steps;
    rawResult = await runQuickstartContract(loaded.contract, {
      preserveWorkspace: false,
      readmeBaseDir: config.workingDir,
    });
  } else {
    rawResult = buildInvalidContractResult(config.contractPath, loaded.errors);
  }

  const sanitized = sanitizeRunResultForAction(rawResult, sanitizeOptions);
  const resultPath = await writeActionResultFile(config.runnerTempDir, sanitized);
  const summaryHtml = renderStepSummary(sanitized, {
    contractPath: config.contractPath,
    declaredSteps,
    sanitizeOptions,
  });

  return {
    ok: true,
    result: sanitized,
    outputs: buildActionOutputs(sanitized, resultPath),
    summaryHtml,
    failureMessage: buildFailureMessage(sanitized),
  };
}
