import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildMinimalEnv, redactSecrets } from "../bot/lib/execute.js";
import {
  buildStatusSite,
  CatalogSchema,
  extractResolvedVersion,
  loadAndValidateCatalog,
  normalizeTargetResult,
  runCatalog,
  sanitizePublicExcerpt,
  validateCatalogContractPolicy,
  type CatalogTarget,
} from "../scripts/catalog-lib.js";
import type { QuickstartContract } from "../bot/lib/contract.js";
import type { QuickstartRunResult } from "../bot/lib/execute.js";
import { ShieldsEndpointSchema } from "../scripts/badges.js";
import { HistoryDocumentSchema, mergeHistory } from "../scripts/history.js";
import { mergePlatformRuns } from "../scripts/merge-platform-results.js";
import {
  PlatformRunDocumentSchema,
  summarizePlatformRun,
  toPlatformPartialTarget,
  type PlatformId,
} from "../scripts/status-v2.js";

const REPO_ROOT = process.cwd();

describe("catalog validation and security", () => {
  it("validates the real repository catalog/targets.json and all 20 contracts", async () => {
    const outcome = await loadAndValidateCatalog(REPO_ROOT, "catalog/targets.json");
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.catalog.targets.length, 20);
    assert.equal(outcome.contracts.size, 20);
  });

  it("rejects duplicate target IDs, repo-escaping paths, and non-HTTPS URLs", () => {
    const baseTarget = {
      id: "demo-sdk",
      name: "Demo SDK",
      package: "demo-sdk",
      docsUrl: "https://example.com/docs",
      repositoryUrl: "https://github.com/example/demo",
      contractPath: "catalog/contracts/demo/docrun.json",
      scope: "install + import",
    };

    const dup = CatalogSchema.safeParse({
      schemaVersion: 1,
      targets: [baseTarget, { ...baseTarget }],
    });
    assert.equal(dup.success, false);

    const escapePath = CatalogSchema.safeParse({
      schemaVersion: 1,
      targets: [{ ...baseTarget, contractPath: "../outside/docrun.json" }],
    });
    assert.equal(escapePath.success, false);

    const httpUrl = CatalogSchema.safeParse({
      schemaVersion: 1,
      targets: [{ ...baseTarget, docsUrl: "http://example.com/docs" }],
    });
    assert.equal(httpUrl.success, false);
  });

  it("rejects disallowed npm subcommands in catalog contract policy", () => {
    const badContract: QuickstartContract = {
      schemaVersion: 1,
      name: "bad-npm",
      files: {},
      steps: [
        {
          id: "publish",
          command: "npm",
          args: ["publish"],
          timeoutMs: 10_000,
          expect: { exitCode: 0 },
        },
      ],
    };
    const errors = validateCatalogContractPolicy("bad-npm", badContract);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not allowed/);
  });

  it("extracts resolved package versions from npm list JSON output", () => {
    const ver = extractResolvedVersion("@grok/agent-sdk", [
      {
        id: "resolved-version",
        stdout: JSON.stringify({
          dependencies: {
            "@grok/agent-sdk": { version: "0.7.2" },
          },
        }),
      },
    ]);
    assert.equal(ver, "0.7.2");

    const pipVer = extractResolvedVersion("claude-agent-sdk", [
      {
        id: "resolved-version",
        stdout: JSON.stringify([
          { name: "anyio", version: "4.10.0" },
          { name: "claude_agent_sdk", version: "0.2.187" },
        ]),
      },
    ]);
    assert.equal(pipVer, "0.2.187");

    const invalid = extractResolvedVersion("@grok/agent-sdk", [
      { id: "resolved-version", stdout: "not json" },
    ]);
    assert.equal(invalid, null);
  });

  it("strips host secrets from child env and isolates npm cache inside temp workspace", () => {
    const prevGh = process.env.GITHUB_TOKEN;
    const prevCursor = process.env.CURSOR_API_KEY;
    process.env.GITHUB_TOKEN = "ghs_test_secret_value_12345678901234567890";
    process.env.CURSOR_API_KEY = "sk-test-secret-value-12345678901234567890";
    try {
      const env = buildMinimalEnv("/tmp/docrun-abc");
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.CURSOR_API_KEY, undefined);
      assert.equal(env.npm_config_cache, path.join("/tmp/docrun-abc", ".npm-cache"));
      assert.equal(env.npm_config_userconfig, path.join("/tmp/docrun-abc", ".npmrc-empty"));
    } finally {
      if (prevGh === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevGh;
      if (prevCursor === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prevCursor;
    }
  });

  it("redacts GitHub Actions ghs_ tokens and scrubs local paths from public excerpts", () => {
    const redacted = redactSecrets("token=ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    assert.doesNotMatch(redacted, /ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456/);

    const excerpt = sanitizePublicExcerpt(
      "Error in C:\\Users\\alice\\AppData\\Local\\Temp\\docrun-xyz123\\index.mjs with ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    );
    assert.doesNotMatch(excerpt.text, /alice/);
    assert.doesNotMatch(excerpt.text, /docrun-xyz123/);
    assert.doesNotMatch(excerpt.text, /ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456/);
  });

  it("separates failed vs infra_error and marks unexecuted steps as skipped", () => {
    const target: CatalogTarget = {
      id: "demo",
      name: "Demo",
      package: "demo",
      docsUrl: "https://example.com/docs",
      repositoryUrl: "https://github.com/example/demo",
      contractPath: "catalog/contracts/demo/docrun.json",
      scope: "install + import",
    };
    const contract: QuickstartContract = {
      schemaVersion: 1,
      name: "demo",
      files: {},
      steps: [
        { id: "step-1", command: "node", args: ["-v"], timeoutMs: 5000, expect: { exitCode: 0 } },
        { id: "step-2", command: "node", args: ["a.mjs"], timeoutMs: 5000, expect: { exitCode: 0 } },
      ],
    };

    const envFailRun: QuickstartRunResult = {
      runId: "r1",
      contractName: "demo",
      schemaVersion: 1,
      status: "failed",
      failureCategory: "environment_failed",
      firstFailedStepId: "step-1",
      startedAt: "2026-11-21T00:00:00.000Z",
      durationMs: 10,
      platform: "linux",
      nodeVersion: "v22.0.0",
      workspacePreserved: false,
      preservedWorkspaceDir: null,
      cleanup: { attempted: true, succeeded: true, error: null },
      validationErrors: [],
      readmeDrift: { checked: false, ok: true, reason: null, expectedCommands: [], observedCommands: [] },
      steps: [
        {
          id: "step-1",
          command: "node",
          args: ["-v"],
          status: "failed",
          failureCategory: "environment_failed",
          exitCode: null,
          signal: null,
          durationMs: 10,
          timedOut: false,
          assertions: [],
          stdout: "",
          stderr: "spawn ENOENT",
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ],
      failedAssertions: [],
      fingerprint: "abcd1234abcd1234",
    };

    const normalized = normalizeTargetResult(target, contract, envFailRun);
    assert.equal(normalized.status, "infra_error");
    assert.equal(normalized.steps.length, 2);
    assert.equal(normalized.steps[1].status, "skipped");
  });
});

describe("catalog runner and status site integration", () => {
  it("runs a 2-target catalog (1 pass, 1 redacted fail) and builds the v2 status site", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-cat-test-"));
    try {
      await fs.mkdir(path.join(tmpBase, "contracts"), { recursive: true });
      await fs.writeFile(
        path.join(tmpBase, "contracts", "pass.json"),
        JSON.stringify({
          schemaVersion: 1,
          name: "pass-fixture",
          files: { "ok.mjs": "console.log('ready');\n" },
          steps: [
            { id: "run-ok", command: "node", args: ["ok.mjs"], timeoutMs: 10_000, expect: { exitCode: 0, stdoutIncludes: ["ready"] } },
          ],
        }),
      );
      await fs.writeFile(
        path.join(tmpBase, "contracts", "fail.json"),
        JSON.stringify({
          schemaVersion: 1,
          name: "fail-fixture",
          files: { "bad.mjs": "console.error('leak ghs_SECRETTOKEN1234567890123456'); process.exit(1);\n" },
          steps: [
            { id: "run-bad", command: "node", args: ["bad.mjs"], timeoutMs: 10_000, expect: { exitCode: 0 } },
            { id: "after-bad", command: "node", args: ["-v"], timeoutMs: 10_000, expect: { exitCode: 0 } },
          ],
        }),
      );
      await fs.writeFile(
        path.join(tmpBase, "targets.json"),
        JSON.stringify({
          schemaVersion: 1,
          targets: [
            {
              id: "pass-target",
              name: "Pass Fixture",
              package: "pass-pkg",
              docsUrl: "https://example.com/pass",
              repositoryUrl: "https://github.com/example/pass",
              contractPath: "contracts/pass.json",
              scope: "local fixture pass",
            },
            {
              id: "fail-target",
              name: "Fail Fixture",
              package: "fail-pkg",
              docsUrl: "https://example.com/fail",
              repositoryUrl: "https://github.com/example/fail",
              contractPath: "contracts/fail.json",
              scope: "local fixture fail",
            },
          ],
        }),
      );

      const status = await runCatalog({
        baseDir: tmpBase,
        catalogPath: "targets.json",
        sourceCommit: "abc1234",
      });

      assert.equal(status.summary.total, 2);
      assert.equal(status.summary.passed, 1);
      assert.equal(status.summary.failed, 1);
      assert.equal(status.summary.infraErrors, 0);

      const failedTarget = status.targets.find((t) => t.id === "fail-target");
      assert.ok(failedTarget);
      assert.equal(failedTarget.firstFailedStepId, "run-bad");
      assert.equal(failedTarget.steps[1].status, "skipped");
      assert.doesNotMatch(JSON.stringify(status), /ghs_SECRETTOKEN1234567890123456/);

      assert.equal(status.schemaVersion, 1);

      const catalog = CatalogSchema.parse(
        JSON.parse(await fs.readFile(path.join(tmpBase, "targets.json"), "utf8")),
      );
      const environmentFor = (platform: PlatformId) => ({
        osName: platform === "ubuntu" ? "Ubuntu" : "Windows",
        osVersion: platform === "ubuntu" ? "24.04.1" : "10.0.26200",
        osRelease: platform === "ubuntu" ? "6.8.0" : "10.0.26200",
        arch: "x64",
        nodeVersion: "v22.14.0",
        npmVersion: "10.9.2",
        runnerImage: platform === "ubuntu" ? "ubuntu-24.04" : "windows-2025",
      });
      const toPlatformRun = (platform: PlatformId) => {
        const targets = status.targets.map((target) => toPlatformPartialTarget(target.id, target));
        return PlatformRunDocumentSchema.parse({
          schemaVersion: 2,
          kind: "platform-run",
          platform,
          generatedAt: status.generatedAt,
          sourceCommit: status.sourceCommit,
          environment: environmentFor(platform),
          summary: summarizePlatformRun(targets),
          targets,
        });
      };
      const aggregate = mergePlatformRuns({
        catalog,
        platforms: {
          ubuntu: { ok: true, document: toPlatformRun("ubuntu") },
          windows: { ok: true, document: toPlatformRun("windows") },
        },
        sourceCommit: status.sourceCommit,
        generatedAt: status.generatedAt,
      });
      const history = mergeHistory(null, aggregate);

      const statusPath = path.join(tmpBase, "status.json");
      const historyPath = path.join(tmpBase, "history.json");
      const outDir = path.join(tmpBase, "dist-site");
      await fs.writeFile(statusPath, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
      await fs.writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");

      await buildStatusSite({
        siteSrcDir: path.join(REPO_ROOT, "site"),
        statusJsonPath: statusPath,
        historyJsonPath: historyPath,
        outDir,
      });

      const builtFiles = await fs.readdir(outDir);
      for (const required of ["index.html", "styles.css", "app.js", "status.json", "history.json", ".nojekyll"]) {
        assert.ok(builtFiles.includes(required), required);
      }
      for (const asset of ["index.html", "styles.css", "app.js"]) {
        const stat = await fs.stat(path.join(outDir, asset));
        assert.ok(stat.size > 0, asset);
      }

      const builtStatus = JSON.parse(await fs.readFile(path.join(outDir, "status.json"), "utf8"));
      assert.equal(builtStatus.schemaVersion, 2);
      assert.equal(builtStatus.kind, "aggregate-status");
      assert.equal(builtStatus.overallStatus, "failed");
      assert.deepEqual(
        builtStatus.targets.map((target: { id: string }) => target.id),
        ["pass-target", "fail-target"],
      );

      const builtHistory = HistoryDocumentSchema.parse(
        JSON.parse(await fs.readFile(path.join(outDir, "history.json"), "utf8")),
      );
      assert.equal(builtHistory.days.length, 1);
      const historyText = JSON.stringify(builtHistory);
      assert.equal(historyText.includes("stdout"), false);
      assert.equal(historyText.includes("stderr"), false);
      assert.equal(historyText.includes("ghs_SECRETTOKEN1234567890123456"), false);

      const badgeNames = await fs.readdir(path.join(outDir, "badges"));
      assert.deepEqual(
        [...badgeNames].sort(),
        [
          "fail-target-ubuntu.json",
          "fail-target-windows.json",
          "overall.json",
          "pass-target-ubuntu.json",
          "pass-target-windows.json",
        ],
      );
      for (const name of badgeNames) {
        const badge = ShieldsEndpointSchema.parse(
          JSON.parse(await fs.readFile(path.join(outDir, "badges", name), "utf8")),
        );
        assert.ok(badge.label.length <= 64);
        assert.ok(badge.message.length <= 64);
      }
      const overallBadge = ShieldsEndpointSchema.parse(
        JSON.parse(await fs.readFile(path.join(outDir, "badges", "overall.json"), "utf8")),
      );
      assert.equal(overallBadge.color, "red");
      const passBadge = ShieldsEndpointSchema.parse(
        JSON.parse(await fs.readFile(path.join(outDir, "badges", "pass-target-ubuntu.json"), "utf8")),
      );
      assert.equal(passBadge.color, "green");
      const failBadge = ShieldsEndpointSchema.parse(
        JSON.parse(await fs.readFile(path.join(outDir, "badges", "fail-target-windows.json"), "utf8")),
      );
      assert.equal(failBadge.color, "red");

      await assert.rejects(
        () =>
          runCatalog({
            baseDir: tmpBase,
            catalogPath: "targets.json",
            targetIds: ["does-not-exist"],
          }),
        /Unknown catalog target id/,
      );

      const v1StatusPath = path.join(tmpBase, "status-v1.json");
      await fs.writeFile(v1StatusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
      await assert.rejects(
        () =>
          buildStatusSite({
            siteSrcDir: path.join(REPO_ROOT, "site"),
            statusJsonPath: v1StatusPath,
            outDir: path.join(tmpBase, "dist-v1"),
          }),
        /Invalid status\.json schema/,
      );
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
