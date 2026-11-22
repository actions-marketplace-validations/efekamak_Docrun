import * as core from "@actions/core";
import { buildWrapperErrorOutputs, type ActionOutputs } from "./result.js";
import { executeDocrunAction } from "./runner.js";

function emitOutputs(outputs: ActionOutputs): void {
  for (const [key, value] of Object.entries(outputs)) {
    core.setOutput(key, value);
  }
}

async function writeSummaryIfAvailable(html: string): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }
  try {
    await core.summary.addRaw(html).write();
  } catch {
    core.warning("Could not write GitHub Step Summary.");
  }
}

export async function run(): Promise<void> {
  try {
    const contract = core.getInput("contract");
    const workingDirectory = core.getInput("working-directory");

    const outcome = await executeDocrunAction(
      { contract, workingDirectory },
      {
        GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
        RUNNER_TEMP: process.env.RUNNER_TEMP,
      },
    );

    emitOutputs(outcome.outputs);
    await writeSummaryIfAvailable(outcome.summaryHtml);

    if (outcome.failureMessage !== null) {
      core.setFailed(outcome.failureMessage);
    } else if (outcome.ok) {
      core.info(
        `docrun passed: ${outcome.result.contractName} (${outcome.result.durationMs} ms)`,
      );
    }
  } catch {
    emitOutputs(buildWrapperErrorOutputs());
    await writeSummaryIfAvailable(
      "<h3>docrun: error</h3>\n<p>docrun action failed due to an internal error.</p>\n",
    );
    core.setFailed("docrun action failed due to an internal error.");
  }
}

void run();
