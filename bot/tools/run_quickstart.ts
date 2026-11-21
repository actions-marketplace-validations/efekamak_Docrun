import { prompt } from "@grok/agent-sdk";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { loadContractFile } from "../lib/contract.js";
import {
  buildInvalidContractResult,
  runQuickstartContract,
  type QuickstartRunResult,
} from "../lib/execute.js";

export default defineTool({
  description: prompt`
    Validate and execute a declared docrun.json contract in a fresh temporary workspace.
    Returns deterministic step results, bounded redacted output, assertion outcomes, and a failure fingerprint.
    Call this tool once per requested quickstart run.
  `,
  inputSchema: z.object({
    contractPath: z
      .string()
      .min(1)
      .describe("Workspace-relative path to a docrun.json contract file."),
    preserveWorkspace: z
      .boolean()
      .optional()
      .describe("Local debugging only: keep the temporary workspace directory after the run."),
  }),
  effect: "write",
  dryRunResult: ({ contractPath }): QuickstartRunResult => ({
    runId: "dry-run",
    contractName: contractPath,
    schemaVersion: 1,
    status: "passed",
    failureCategory: null,
    firstFailedStepId: null,
    startedAt: new Date(0).toISOString(),
    durationMs: 0,
    platform: process.platform,
    nodeVersion: process.version,
    workspacePreserved: false,
    preservedWorkspaceDir: null,
    cleanup: { attempted: false, succeeded: true, error: null },
    validationErrors: [],
    readmeDrift: {
      checked: false,
      ok: true,
      reason: null,
      expectedCommands: [],
      observedCommands: [],
    },
    steps: [],
    failedAssertions: [],
    fingerprint: null,
  }),
  async execute({ contractPath, preserveWorkspace }, ctx): Promise<QuickstartRunResult> {
    const loaded = await loadContractFile(ctx.workspaceDir, contractPath);
    const result = loaded.ok
      ? await runQuickstartContract(loaded.contract, {
          preserveWorkspace: preserveWorkspace ?? false,
          readmeBaseDir: ctx.workspaceDir,
        })
      : buildInvalidContractResult(contractPath, loaded.errors);

    await ctx.artifacts.tag({
      kind: "quickstart-run",
      key: `run:${result.contractName}:${result.runId}`,
      title: `Quickstart run: ${result.contractName} (${result.status})`,
      data: {
        runId: result.runId,
        contractName: result.contractName,
        status: result.status,
        failureCategory: result.failureCategory,
        firstFailedStepId: result.firstFailedStepId,
        durationMs: result.durationMs,
        fingerprint: result.fingerprint,
      },
      contents: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    return result;
  },
});
