import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveActionConfig } from "../action/config.js";
import {
  buildActionOutputs,
  buildWrapperErrorOutputs,
  sanitizeRunResultForAction,
  writeActionResultFile,
} from "../action/result.js";
import { executeDocrunAction } from "../action/runner.js";
import { SUMMARY_LIMITS, escapeHtml, renderStepSummary } from "../action/summary.js";
import type { QuickstartRunResult } from "../bot/lib/execute.js";

async function withTempDirs(
  fn: (dirs: { root: string; workspace: string; runnerTemp: string }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-action-test-"));
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(runnerTemp, { recursive: true });
  try {
    await fn({ root, workspace, runnerTemp });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function makeSampleResult(overrides: Partial<QuickstartRunResult> = {}): QuickstartRunResult {
  return {
    runId: "run-test-1234",
    contractName: "sample-contract",
    schemaVersion: 1,
    status: "passed",
    failureCategory: null,
    firstFailedStepId: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 42,
    platform: process.platform,
    nodeVersion: process.version,
    workspacePreserved: false,
    preservedWorkspaceDir: null,
    cleanup: { attempted: true, succeeded: true, error: null },
    validationErrors: [],
    readmeDrift: {
      checked: false,
      ok: true,
      reason: null,
      expectedCommands: [],
      observedCommands: [],
    },
    steps: [
      {
        id: "step-1",
        command: "node",
        args: ["--version"],
        status: "passed",
        failureCategory: null,
        exitCode: 0,
        signal: null,
        durationMs: 12,
        timedOut: false,
        assertions: [{ kind: "exitCode", expected: "0", observed: "0", passed: true }],
        stdout: "v24.0.0\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    ],
    failedAssertions: [],
    fingerprint: null,
    ...overrides,
  };
}

function parseGithubOutputFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i += 1;
      continue;
    }
    const delimMatch = line.match(/^([^=<]+)<<(.+)$/);
    if (delimMatch) {
      const key = delimMatch[1];
      const delim = delimMatch[2];
      const valueLines: string[] = [];
      i += 1;
      while (i < lines.length && lines[i] !== delim) {
        valueLines.push(lines[i]);
        i += 1;
      }
      out[key] = valueLines.join("\n");
      i += 1;
      continue;
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx > 0) {
      out[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
    }
    i += 1;
  }
  return out;
}

async function runBundledActionSubprocess(
  envOverrides: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const bundlePath = path.resolve("dist-action", "index.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundlePath], {
      env: { ...process.env, ...envOverrides },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe("action config and workspace containment", () => {
  it("applies default inputs and resolves monorepo working-directory", async () => {
    await withTempDirs(async ({ workspace, runnerTemp }) => {
      const subDir = path.join(workspace, "packages", "sdk");
      await fs.mkdir(subDir, { recursive: true });

      const defaults = await resolveActionConfig(
        {},
        { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp },
      );
      assert.equal(defaults.ok, true);
      if (defaults.ok) {
        assert.equal(defaults.config.contractPath, "docrun.json");
        assert.equal(defaults.config.workingDirectoryInput, ".");
        assert.equal(defaults.config.workingDir, await fs.realpath(workspace));
      }

      const monorepo = await resolveActionConfig(
        { contract: "./contracts/docrun.json", workingDirectory: "./packages/sdk/" },
        { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp },
      );
      assert.equal(monorepo.ok, true);
      if (monorepo.ok) {
        assert.equal(monorepo.config.contractPath, "contracts/docrun.json");
        assert.equal(monorepo.config.workingDir, await fs.realpath(subDir));
      }

      const dotSlashRoot = await resolveActionConfig(
        { contract: "./docrun.json", workingDirectory: "./" },
        { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp },
      );
      assert.equal(dotSlashRoot.ok, true);
      if (dotSlashRoot.ok) {
        assert.equal(dotSlashRoot.config.contractPath, "docrun.json");
        assert.equal(dotSlashRoot.config.workingDir, await fs.realpath(workspace));
      }
    });
  });

  it("rejects traversal, absolute paths, drive prefixes, null bytes, missing dirs, and file-as-dir", async () => {
    await withTempDirs(async ({ workspace, runnerTemp }) => {
      const filePath = path.join(workspace, "not-a-dir.txt");
      await fs.writeFile(filePath, "hi", "utf8");

      const badWorkingDirs = [
        "..",
        "../outside",
        "./../outside",
        "a/../b",
        "a/./b",
        "/etc",
        "\\windows",
        "C:relative",
        "C:\\Windows",
        "bad\0dir",
        "missing-dir",
        "not-a-dir.txt",
        "trailing-dot.",
        "trailing-space /sub",
      ];

      for (const wd of badWorkingDirs) {
        const res = await resolveActionConfig(
          { workingDirectory: wd },
          { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp },
        );
        assert.equal(res.ok, false, `Expected working-directory "${wd}" to be rejected`);
        if (!res.ok) {
          assert.equal(res.kind, "invalid_input");
        }
      }

      const badContracts = [
        "../docrun.json",
        "/etc/passwd",
        "C:\\docrun.json",
        "docrun\0.json",
      ];
      for (const contract of badContracts) {
        const res = await resolveActionConfig(
          { contract },
          { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp },
        );
        assert.equal(res.ok, false, `Expected contract "${contract}" to be rejected`);
        if (!res.ok) {
          assert.equal(res.kind, "invalid_input");
        }
      }
    });
  });

  it("rejects working-directory symlink escaping GITHUB_WORKSPACE", async () => {
    await withTempDirs(async ({ root, workspace, runnerTemp }) => {
      const outside = path.join(root, "outside");
      await fs.mkdir(outside, { recursive: true });
      const linkPath = path.join(workspace, "escaped-link");

      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(outside, linkPath, symlinkType);

      const res = await resolveActionConfig(
        { workingDirectory: "escaped-link" },
        { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp },
      );
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.kind, "invalid_input");
        assert.match(res.message, /symlink escapes/i);
      }
    });
  });

  it("returns environment_error when GITHUB_WORKSPACE or RUNNER_TEMP is missing", async () => {
    const missingWs = await resolveActionConfig({}, { RUNNER_TEMP: os.tmpdir() });
    assert.equal(missingWs.ok, false);
    if (!missingWs.ok) {
      assert.equal(missingWs.kind, "environment_error");
    }

    const missingTemp = await resolveActionConfig({}, { GITHUB_WORKSPACE: os.tmpdir() });
    assert.equal(missingTemp.ok, false);
    if (!missingTemp.ok) {
      assert.equal(missingTemp.kind, "environment_error");
    }
  });
});

describe("action result sanitization, outputs, and file writing", () => {
  it("maps outputs cleanly for passed, failed, invalid, and wrapper error", () => {
    const passed = buildActionOutputs(makeSampleResult(), "/tmp/docrun/run-1.json");
    assert.deepEqual(passed, {
      status: "passed",
      "failure-category": "",
      "first-failed-step": "",
      fingerprint: "",
      "duration-ms": "42",
      "result-path": "/tmp/docrun/run-1.json",
    });

    const failed = buildActionOutputs(
      makeSampleResult({
        status: "failed",
        failureCategory: "assertion_failed",
        firstFailedStepId: "run-example",
        fingerprint: "abcdef0123456789",
        durationMs: 123.6,
      }),
      "/tmp/docrun/run-2.json",
    );
    assert.deepEqual(failed, {
      status: "failed",
      "failure-category": "assertion_failed",
      "first-failed-step": "run-example",
      fingerprint: "abcdef0123456789",
      "duration-ms": "124",
      "result-path": "/tmp/docrun/run-2.json",
    });

    const invalid = buildActionOutputs(
      makeSampleResult({
        status: "invalid",
        failureCategory: "contract_invalid",
        fingerprint: "1122334455667788",
        durationMs: 0,
      }),
      "/tmp/docrun/run-3.json",
    );
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid["failure-category"], "contract_invalid");

    const wrapperErr = buildWrapperErrorOutputs();
    assert.deepEqual(wrapperErr, {
      status: "error",
      "failure-category": "internal_error",
      "first-failed-step": "",
      fingerprint: "",
      "duration-ms": "0",
      "result-path": "",
    });
  });

  it("scrubs secrets and local paths across all fields including assertion expected values", async () => {
    await withTempDirs(async ({ workspace, runnerTemp }) => {
      const ghToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
      const ghsToken = "ghs_ZYXWVUTSRQPONMLKJIHGFEDCBA654321";
      const apiKey = "sk-proj-secretValue1234567890";
      const credUrl = "https://registryuser:topsecretpass@registry.example.com/pkg";
      const pemKey =
        "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

      const raw = makeSampleResult({
        status: "failed",
        failureCategory: "assertion_failed",
        firstFailedStepId: "step-1",
        preservedWorkspaceDir: "C:\\Users\\winlocaluser\\AppData\\Local\\Temp\\docrun-abc123",
        workspacePreserved: true,
        cleanup: {
          attempted: true,
          succeeded: false,
          error: `Could not remove ${workspace}\\tmp with ${ghsToken}`,
        },
        validationErrors: [`Bad file at /home/linuxlocaluser/project/docrun.json with ${apiKey}`],
        failedAssertions: [
          {
            kind: "stdoutIncludes",
            expected: `token=${ghToken} url=${credUrl}`,
            observed: "not found in stdout",
            passed: false,
          },
        ],
        steps: [
          {
            id: "step-1",
            command: "node",
            args: ["-e", `console.log("${ghToken}")`],
            status: "failed",
            failureCategory: "assertion_failed",
            exitCode: 1,
            signal: null,
            durationMs: 15,
            timedOut: false,
            assertions: [
              {
                kind: "stdoutIncludes",
                expected: `secret=${ghToken}`,
                observed: "not found",
                passed: false,
              },
            ],
            stdout: `Output from ${workspace}/index.mjs with ${ghsToken} and ${credUrl}`,
            stderr: `Error at C:\\Users\\winlocaluser\\AppData\\Local\\Temp\\docrun-xyz999\\a.js\n${pemKey}`,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        ],
      });

      const sanitizeOptions = {
        extraPathReplacements: [
          { path: workspace, replacement: "<workspace>" },
          { path: runnerTemp, replacement: "<runner-temp>" },
        ],
      };

      const sanitized = sanitizeRunResultForAction(raw, sanitizeOptions);

      assert.equal(sanitized.workspacePreserved, false);
      assert.equal(sanitized.preservedWorkspaceDir, null);

      const writtenPath = await writeActionResultFile(runnerTemp, sanitized);
      const rawJson = await fs.readFile(writtenPath, "utf8");
      const parsed = JSON.parse(rawJson) as QuickstartRunResult;
      assert.equal(parsed.status, "failed");

      const summaryHtml = renderStepSummary(sanitized, {
        contractPath: "docrun.json",
        sanitizeOptions,
      });

      for (const leak of [
        ghToken,
        ghsToken,
        apiKey,
        "topsecretpass",
        "MIIBVQIBADANBgkqhkiG9w0BAQEFAASC",
        "docrun-xyz999",
        "winlocaluser",
        "linuxlocaluser",
        workspace,
      ]) {
        assert.equal(rawJson.includes(leak), false, `Expected result file not to contain: ${leak}`);
        assert.equal(summaryHtml.includes(leak), false, `Expected summary not to contain: ${leak}`);
      }

      // Refuses overwrite on same runId (wx flag).
      await assert.rejects(() => writeActionResultFile(runnerTemp, sanitized));
    });
  });

  it("refuses to write result file through a symlinked RUNNER_TEMP/docrun directory", async () => {
    await withTempDirs(async ({ root, runnerTemp }) => {
      const outside = path.join(root, "outside-results");
      await fs.mkdir(outside, { recursive: true });
      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(outside, path.join(runnerTemp, "docrun"), symlinkType);

      await assert.rejects(() => writeActionResultFile(runnerTemp, makeSampleResult()));
    });
  });
});

describe("action Step Summary rendering", () => {
  it("escapes HTML, script tags, closing pre tags, pipes, and backticks", () => {
    assert.equal(escapeHtml(`</pre><script>alert("x")</script> & 'a'`), `&lt;/pre&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;a&#39;`);

    const malicious = `</pre><script>alert(1)</script> | col | \`\`\`bash\n# injected`;
    const result = makeSampleResult({
      status: "failed",
      failureCategory: "assertion_failed",
      firstFailedStepId: "run-example",
      fingerprint: "deadbeef00112233",
      failedAssertions: [
        {
          kind: "stdoutIncludes",
          expected: malicious,
          observed: "not found in stdout",
          passed: false,
        },
      ],
      steps: [
        {
          id: "run-example",
          command: "node",
          args: ["index.mjs"],
          status: "failed",
          failureCategory: "assertion_failed",
          exitCode: 0,
          signal: null,
          durationMs: 25,
          timedOut: false,
          assertions: [],
          stdout: malicious,
          stderr: malicious,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ],
    });

    const summary = renderStepSummary(result, {
      contractPath: "docrun.json",
      declaredSteps: [
        { id: "run-example", command: "node", args: ["index.mjs"] },
        { id: "never-ran", command: "node", args: ["-v"] },
      ],
    });

    assert.equal(summary.includes("<script>"), false);
    assert.equal(summary.includes("&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;"), true);
    assert.match(summary, /<td>skipped<\/td>/);
    // Ensure every <pre> has a matching </pre>
    assert.equal(summary.match(/<pre>/g)?.length, summary.match(/<\/pre>/g)?.length);
  });

  it("enforces summary and evidence byte limits safely with multi-byte UTF-8 text", () => {
    const utf8Chunk = "ğüşöçıİ日本語🚀".repeat(4000);
    const result = makeSampleResult({
      status: "failed",
      failureCategory: "runtime_failed",
      firstFailedStepId: "step-1",
      fingerprint: "0011223344556677",
      steps: [
        {
          id: "step-1",
          command: "node",
          args: ["index.mjs"],
          status: "failed",
          failureCategory: "runtime_failed",
          exitCode: 1,
          signal: null,
          durationMs: 90,
          timedOut: false,
          assertions: [],
          stdout: utf8Chunk,
          stderr: utf8Chunk,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ],
    });

    const fullSummary = renderStepSummary(result, { contractPath: "docrun.json" });
    assert.ok(Buffer.byteLength(fullSummary, "utf8") <= SUMMARY_LIMITS.MAX_SUMMARY_BYTES);
    assert.equal(fullSummary.includes("\uFFFD"), false);
    assert.equal(fullSummary.match(/<pre>/g)?.length, fullSummary.match(/<\/pre>/g)?.length);

    const tightSummary = renderStepSummary(result, {
      contractPath: "docrun.json",
      maxSummaryBytes: 1_024,
      maxEvidenceBytes: 512,
    });
    assert.ok(Buffer.byteLength(tightSummary, "utf8") <= 1_024);
    assert.equal(tightSummary.includes("\uFFFD"), false);
    assert.equal(tightSummary.match(/<table>/g)?.length, tightSummary.match(/<\/table>/g)?.length);
  });
});

describe("action runner and bundled entrypoint end-to-end", () => {
  it("runs passing, failing, and invalid contracts via executeDocrunAction", async () => {
    await withTempDirs(async ({ runnerTemp }) => {
      const repoRoot = path.resolve(".");

      const passOutcome = await executeDocrunAction(
        { contract: "fixtures/passing/docrun.json" },
        { GITHUB_WORKSPACE: repoRoot, RUNNER_TEMP: runnerTemp },
      );
      assert.equal(passOutcome.ok, true);
      assert.equal(passOutcome.outputs.status, "passed");
      assert.equal(passOutcome.outputs["failure-category"], "");
      assert.equal(passOutcome.failureMessage, null);
      assert.ok(passOutcome.outputs["result-path"].startsWith(await fs.realpath(runnerTemp)));

      const failOutcome = await executeDocrunAction(
        { contract: "fixtures/failing/docrun.json" },
        { GITHUB_WORKSPACE: repoRoot, RUNNER_TEMP: runnerTemp },
      );
      assert.equal(failOutcome.ok, true);
      assert.equal(failOutcome.outputs.status, "failed");
      assert.equal(failOutcome.outputs["failure-category"], "assertion_failed");
      assert.equal(failOutcome.outputs["first-failed-step"], "run-example");
      assert.ok(failOutcome.outputs.fingerprint.length === 16);
      assert.ok(failOutcome.failureMessage !== null);
      assert.match(failOutcome.summaryHtml, /should-not-run[\s\S]*skipped/);

      const invalidOutcome = await executeDocrunAction(
        { contract: "fixtures/invalid/docrun.json" },
        { GITHUB_WORKSPACE: repoRoot, RUNNER_TEMP: runnerTemp },
      );
      assert.equal(invalidOutcome.ok, true);
      assert.equal(invalidOutcome.outputs.status, "invalid");
      assert.equal(invalidOutcome.outputs["failure-category"], "contract_invalid");
      assert.ok(invalidOutcome.failureMessage !== null);
    });
  });

  it("executes committed dist-action/index.js cleanly and strips parent secrets from child env", async () => {
    await withTempDirs(async ({ workspace, runnerTemp }) => {
      const envCheckContract = {
        schemaVersion: 1,
        name: "env-isolation-check",
        files: {
          "check.mjs":
            "const leaked = ['GITHUB_TOKEN','CURSOR_API_KEY','ACTIONS_ID_TOKEN_REQUEST_TOKEN'].filter((k) => Boolean(process.env[k]));\nconsole.log('leaked=' + leaked.join(','));\n",
        },
        steps: [
          {
            id: "check-env",
            command: "node",
            args: ["check.mjs"],
            timeoutMs: 15000,
            expect: {
              exitCode: 0,
              stdoutIncludes: ["leaked="],
            },
          },
        ],
      };
      await fs.writeFile(
        path.join(workspace, "docrun.json"),
        JSON.stringify(envCheckContract, null, 2),
        "utf8",
      );

      const outputFile = path.join(runnerTemp, "github-output.txt");
      const summaryFile = path.join(runnerTemp, "github-summary.md");
      await fs.writeFile(outputFile, "", "utf8");
      await fs.writeFile(summaryFile, "", "utf8");

      const runRes = await runBundledActionSubprocess({
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        INPUT_CONTRACT: "docrun.json",
        "INPUT_WORKING-DIRECTORY": ".",
        GITHUB_TOKEN: "ghs_SUPERSECRETGITHUBTOKEN1234567890",
        CURSOR_API_KEY: "sk-proj-SUPERSECRETCURSORKEY1234567890",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret-token-value",
      });

      assert.equal(runRes.code, 0, `Unexpected exit ${runRes.code}: ${runRes.stdout}\n${runRes.stderr}`);
      const outputs = parseGithubOutputFile(await fs.readFile(outputFile, "utf8"));
      assert.equal(outputs.status, "passed");
      assert.equal(outputs["failure-category"], "");
      assert.ok(outputs["result-path"].length > 0);

      const resultJson = JSON.parse(await fs.readFile(outputs["result-path"], "utf8")) as QuickstartRunResult;
      assert.equal(resultJson.steps[0].stdout.trim(), "leaked=");

      const summary = await fs.readFile(summaryFile, "utf8");
      assert.match(summary, /<h3>docrun: passed<\/h3>/);
      assert.equal(summary.includes("SUPERSECRET"), false);
    });
  });

  it("emits outputs and summary before failing when bundled action runs a failing fixture", async () => {
    await withTempDirs(async ({ runnerTemp }) => {
      const outputFile = path.join(runnerTemp, "github-output-fail.txt");
      const summaryFile = path.join(runnerTemp, "github-summary-fail.md");
      await fs.writeFile(outputFile, "", "utf8");
      await fs.writeFile(summaryFile, "", "utf8");

      const runRes = await runBundledActionSubprocess({
        GITHUB_WORKSPACE: path.resolve("."),
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        INPUT_CONTRACT: "fixtures/failing/docrun.json",
        "INPUT_WORKING-DIRECTORY": ".",
      });

      assert.equal(runRes.code, 1);
      const outputs = parseGithubOutputFile(await fs.readFile(outputFile, "utf8"));
      assert.equal(outputs.status, "failed");
      assert.equal(outputs["failure-category"], "assertion_failed");
      assert.equal(outputs["first-failed-step"], "run-example");
      assert.ok(outputs.fingerprint.length === 16);
      assert.ok(outputs["result-path"].length > 0);

      const summary = await fs.readFile(summaryFile, "utf8");
      assert.match(summary, /<h3>docrun: failed<\/h3>/);
      assert.match(summary, /Failure evidence/);
    });
  });

  it("runs npm step via committed bundle with ./ inputs and empty npm_execpath", async () => {
    await withTempDirs(async ({ runnerTemp }) => {
      const outputFile = path.join(runnerTemp, "github-output-npm.txt");
      const summaryFile = path.join(runnerTemp, "github-summary-npm.md");
      await fs.writeFile(outputFile, "", "utf8");
      await fs.writeFile(summaryFile, "", "utf8");

      const runRes = await runBundledActionSubprocess({
        GITHUB_WORKSPACE: path.resolve("."),
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        INPUT_CONTRACT: "./docrun.json",
        "INPUT_WORKING-DIRECTORY": "./fixtures/action-npm/",
        npm_execpath: "",
      });

      assert.equal(runRes.code, 0, `Unexpected exit ${runRes.code}: ${runRes.stdout}\n${runRes.stderr}`);
      const outputs = parseGithubOutputFile(await fs.readFile(outputFile, "utf8"));
      assert.equal(outputs.status, "passed");
      assert.equal(outputs["failure-category"], "");
      assert.ok(outputs["result-path"].length > 0);
    });
  });

  it("runs Python fixture via committed bundle in an isolated venv and records pythonVersion", async () => {
    await withTempDirs(async ({ runnerTemp }) => {
      const outputFile = path.join(runnerTemp, "github-output-python.txt");
      const summaryFile = path.join(runnerTemp, "github-summary-python.md");
      await fs.writeFile(outputFile, "", "utf8");
      await fs.writeFile(summaryFile, "", "utf8");

      const runRes = await runBundledActionSubprocess({
        GITHUB_WORKSPACE: path.resolve("."),
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        INPUT_CONTRACT: "fixtures/action-python/docrun.json",
        "INPUT_WORKING-DIRECTORY": ".",
        GITHUB_TOKEN: "ghs_secret_must_not_reach_python_step",
      });

      assert.equal(runRes.code, 0, `Unexpected exit ${runRes.code}: ${runRes.stdout}\n${runRes.stderr}`);
      const outputs = parseGithubOutputFile(await fs.readFile(outputFile, "utf8"));
      assert.equal(outputs.status, "passed");
      assert.equal(outputs["failure-category"], "");
      assert.ok(outputs["result-path"].length > 0);

      const saved = JSON.parse(await fs.readFile(outputs["result-path"], "utf8")) as {
        pythonVersion?: string;
      };
      assert.match(saved.pythonVersion ?? "", /^\d+\.\d+\.\d+/);

      const summary = await fs.readFile(summaryFile, "utf8");
      assert.match(summary, /Python \d+\.\d+\.\d+/);
    });
  });
});
