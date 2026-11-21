import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  generateBadges,
  ShieldsEndpointSchema,
  writeBadges,
  type ShieldsEndpointBadge,
} from "../scripts/badges.js";
import { buildStatusSite, type CatalogDocument } from "../scripts/catalog-lib.js";
import { loadPlatformArtifact, mergePlatformRuns } from "../scripts/merge-platform-results.js";
import { assertPlatformMatchesHost, cleanMetadataValue } from "../scripts/platform-metadata.js";
import {
  AggregateStatusDocumentSchema,
  PlatformRunDocumentSchema,
  computeAggregateStatus,
  computeOverallStatus,
  summarizePlatformRun,
  type AggregateStatusDocument,
  type AggregateTargetStatus,
  type PlatformEnvironment,
  type PlatformId,
  type PlatformPartialTarget,
  type PlatformRunDocument,
  type PlatformTargetStatus,
} from "../scripts/status-v2.js";

const CHECKED_AT = "2026-11-21T12:00:00.000Z";
const COMMIT = "abc1234";

function environmentFor(platform: PlatformId): PlatformEnvironment {
  return {
    osName: platform === "ubuntu" ? "Ubuntu" : "Windows",
    osVersion: platform === "ubuntu" ? "24.04.1" : "10.0.26200",
    osRelease: platform === "ubuntu" ? "6.8.0" : "10.0.26200",
    arch: "x64",
    nodeVersion: "v22.14.0",
    npmVersion: "10.9.2",
    runnerImage: platform === "ubuntu" ? "ubuntu-24.04" : "windows-2025",
  };
}

function evidenceStep(stdout: string): PlatformPartialTarget["steps"][number] {
  return {
    id: "run-step",
    command: "node",
    args: ["index.mjs"],
    status: "passed",
    failureCategory: null,
    exitCode: 0,
    durationMs: 20,
    assertions: [{ kind: "exitCode", expected: "0", observed: "0", passed: true }],
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function target(id: string, overrides: Partial<PlatformPartialTarget> = {}): PlatformPartialTarget {
  const status = overrides.status ?? "passed";
  return {
    id,
    status,
    resolvedVersion:
      overrides.resolvedVersion !== undefined
        ? overrides.resolvedVersion
        : status === "passed" || status === "failed"
          ? "1.2.3"
          : null,
    checkedAt: overrides.checkedAt ?? CHECKED_AT,
    durationMs: overrides.durationMs ?? 100,
    firstFailedStepId:
      overrides.firstFailedStepId !== undefined
        ? overrides.firstFailedStepId
        : status === "failed"
          ? "run-step"
          : null,
    failureCategory:
      overrides.failureCategory !== undefined
        ? overrides.failureCategory
        : status === "failed"
          ? "assertion_failed"
          : status === "infra_error"
            ? "environment_failed"
            : null,
    fingerprint:
      overrides.fingerprint !== undefined
        ? overrides.fingerprint
        : status === "failed"
          ? "0123456789abcdef"
          : null,
    notRunReason:
      overrides.notRunReason !== undefined
        ? overrides.notRunReason
        : status === "not_run"
          ? `Target "${id}" was not run.`
          : null,
    infraErrorMessage:
      overrides.infraErrorMessage !== undefined
        ? overrides.infraErrorMessage
        : status === "infra_error"
          ? "Platform runner failed before producing results."
          : null,
    steps: overrides.steps ?? [],
  };
}

function platformRaw(platform: PlatformId, targets: PlatformPartialTarget[]) {
  return {
    schemaVersion: 2 as const,
    kind: "platform-run" as const,
    platform,
    generatedAt: CHECKED_AT,
    sourceCommit: COMMIT,
    environment: environmentFor(platform),
    summary: summarizePlatformRun(targets),
    targets,
  };
}

function validPlatformDocument(platform: PlatformId, targets: PlatformPartialTarget[]): PlatformRunDocument {
  return PlatformRunDocumentSchema.parse(platformRaw(platform, targets));
}

function catalogOf(ids: readonly string[]): CatalogDocument {
  return {
    schemaVersion: 1,
    targets: ids.map((id) => ({
      id,
      name: id,
      package: id,
      docsUrl: `https://example.com/${id}/docs`,
      repositoryUrl: `https://github.com/example/${id}`,
      contractPath: `catalog/contracts/${id}/docrun.json`,
      scope: "install + import",
    })),
  };
}

function mergeOutcomes(
  ids: readonly string[],
  platforms: Record<PlatformId, PlatformPartialTarget[] | string>,
): AggregateStatusDocument {
  const outcome = (platform: PlatformId, value: PlatformPartialTarget[] | string) =>
    typeof value === "string"
      ? { ok: false as const, reason: value }
      : { ok: true as const, document: validPlatformDocument(platform, value) };

  return mergePlatformRuns({
    catalog: catalogOf(ids),
    platforms: {
      ubuntu: outcome("ubuntu", platforms.ubuntu),
      windows: outcome("windows", platforms.windows),
    },
    sourceCommit: COMMIT,
    generatedAt: CHECKED_AT,
  });
}

function countSummary(doc: AggregateStatusDocument) {
  const summary = {
    targets: doc.targets.length,
    passed: 0,
    failed: 0,
    infraErrors: 0,
    incomplete: 0,
    platformChecks: 0,
    platformPassed: 0,
    platformFailed: 0,
    platformInfraErrors: 0,
    platformNotRun: 0,
  };
  for (const row of doc.targets) {
    if (row.aggregateStatus === "passed") summary.passed += 1;
    else if (row.aggregateStatus === "failed") summary.failed += 1;
    else if (row.aggregateStatus === "infra_error") summary.infraErrors += 1;
    else summary.incomplete += 1;

    for (const platform of ["ubuntu", "windows"] as const) {
      summary.platformChecks += 1;
      const status = row.results[platform].status;
      if (status === "passed") summary.platformPassed += 1;
      else if (status === "failed") summary.platformFailed += 1;
      else if (status === "infra_error") summary.platformInfraErrors += 1;
      else summary.platformNotRun += 1;
    }
  }
  return summary;
}

describe("platform artifact schema", () => {
  it("accepts valid Ubuntu and Windows partial artifacts", () => {
    const ubuntu = validPlatformDocument("ubuntu", [
      target("alpha", { resolvedVersion: "1.2.3", steps: [evidenceStep("ubuntu-ok")] }),
      target("beta", { status: "failed", resolvedVersion: "0.9.0" }),
    ]);
    const windows = validPlatformDocument("windows", [
      target("alpha", { resolvedVersion: "1.2.3" }),
      target("beta", { status: "infra_error" }),
    ]);

    assert.equal(ubuntu.schemaVersion, 2);
    assert.equal(ubuntu.kind, "platform-run");
    assert.equal(ubuntu.platform, "ubuntu");
    assert.equal(ubuntu.environment.osName, "Ubuntu");
    assert.equal(ubuntu.targets[0].steps[0].stdout, "ubuntu-ok");
    assert.equal(windows.platform, "windows");
    assert.equal(windows.environment.osName, "Windows");
    assert.equal(windows.sourceCommit, COMMIT);

    assert.deepEqual(PlatformRunDocumentSchema.parse(JSON.parse(JSON.stringify(ubuntu))), ubuntu);
    assert.deepEqual(PlatformRunDocumentSchema.parse(JSON.parse(JSON.stringify(windows))), windows);
  });

  it("accepts exactly 10 targets and rejects more than 10", () => {
    const ten = Array.from({ length: 10 }, (_, index) => target(`target-${index + 1}`));
    assert.equal(PlatformRunDocumentSchema.safeParse(platformRaw("ubuntu", ten)).success, true);

    const eleven = [...ten, target("target-11")];
    assert.equal(PlatformRunDocumentSchema.safeParse(platformRaw("windows", eleven)).success, false);
  });

  it("rejects the wrong kind", () => {
    const parsed = PlatformRunDocumentSchema.safeParse({
      ...platformRaw("ubuntu", [target("alpha")]),
      kind: "aggregate-status",
    });
    assert.equal(parsed.success, false);
  });

  it("rejects an unknown platform", () => {
    for (const platform of ["linux", "macos", "win32"]) {
      const parsed = PlatformRunDocumentSchema.safeParse({
        ...platformRaw("ubuntu", [target("alpha")]),
        platform,
      });
      assert.equal(parsed.success, false, platform);
    }
  });

  it("rejects a duplicate target id", () => {
    const parsed = PlatformRunDocumentSchema.safeParse(
      platformRaw("ubuntu", [target("alpha"), target("alpha")]),
    );
    assert.equal(parsed.success, false);
  });

  it("rejects an invalid ISO timestamp", () => {
    for (const generatedAt of ["2026-11-21", "2026-11-21T12:00:00", "2026-13-40T00:00:00Z", "not-a-timestamp"]) {
      const parsed = PlatformRunDocumentSchema.safeParse({
        ...platformRaw("ubuntu", [target("alpha")]),
        generatedAt,
      });
      assert.equal(parsed.success, false, generatedAt);
    }

    const badTargetTime = platformRaw("windows", [target("alpha", { checkedAt: "2026-13-40T00:00:00.000Z" })]);
    assert.equal(PlatformRunDocumentSchema.safeParse(badTargetTime).success, false);
  });

  it("rejects an invalid commit SHA", () => {
    for (const sourceCommit of ["abc", "zzzzzzz", "abc123g", "abc1234\n"]) {
      const parsed = PlatformRunDocumentSchema.safeParse({
        ...platformRaw("ubuntu", [target("alpha")]),
        sourceCommit,
      });
      assert.equal(parsed.success, false, JSON.stringify(sourceCommit));
    }
  });

  it("rejects oversized environment metadata", () => {
    const fields: Array<[keyof PlatformEnvironment, number]> = [
      ["osName", 64],
      ["osVersion", 120],
      ["osRelease", 64],
      ["arch", 32],
      ["nodeVersion", 32],
      ["npmVersion", 32],
      ["runnerImage", 64],
    ];
    for (const [field, max] of fields) {
      const raw = platformRaw("ubuntu", [target("alpha")]);
      const parsed = PlatformRunDocumentSchema.safeParse({
        ...raw,
        environment: { ...raw.environment, [field]: "m".repeat(max + 1) },
      });
      assert.equal(parsed.success, false, field);
    }
  });

  it("rejects unknown extra fields", () => {
    const root = PlatformRunDocumentSchema.safeParse({
      ...platformRaw("ubuntu", [target("alpha")]),
      runner: "hosted",
    });
    assert.equal(root.success, false);

    const raw = platformRaw("windows", [target("alpha")]);
    const environment = PlatformRunDocumentSchema.safeParse({
      ...raw,
      environment: { ...raw.environment, hostname: "builder" },
    });
    assert.equal(environment.success, false);

    const extraTarget = PlatformRunDocumentSchema.safeParse(
      platformRaw("ubuntu", [{ ...target("alpha"), stdout: "leak" } as PlatformPartialTarget]),
    );
    assert.equal(extraTarget.success, false);

    const extraStep = PlatformRunDocumentSchema.safeParse(
      platformRaw("windows", [
        target("alpha", {
          steps: [{ ...evidenceStep("ok"), signal: null } as PlatformPartialTarget["steps"][number]],
        }),
      ]),
    );
    assert.equal(extraStep.success, false);
  });
});

describe("assertPlatformMatchesHost", () => {
  it("rejects mismatched host labels and allows matching pairs", () => {
    assert.throws(
      () => assertPlatformMatchesHost("ubuntu", "win32"),
      /Platform label "ubuntu" requires Linux host \(detected "win32"\)/,
    );
    assert.throws(
      () => assertPlatformMatchesHost("windows", "linux"),
      /Platform label "windows" requires Windows host \(detected "linux"\)/,
    );
    assert.doesNotThrow(() => assertPlatformMatchesHost("ubuntu", "linux"));
    assert.doesNotThrow(() => assertPlatformMatchesHost("windows", "win32"));
  });
});

describe("loadPlatformArtifact", () => {
  it("rejects a missing file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-missing-"));
    try {
      const outcome = await loadPlatformArtifact(path.join(dir, "ubuntu.json"), "ubuntu");
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.match(outcome.reason, /missing/);
      assert.match(outcome.reason, /ubuntu/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an oversized file using maxBytes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-oversize-"));
    try {
      const filePath = path.join(dir, "ubuntu.json");
      await fs.writeFile(filePath, Buffer.alloc(64, 0x61));
      const outcome = await loadPlatformArtifact(filePath, "ubuntu", { maxBytes: 32 });
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.match(outcome.reason, /exceeded the 32-byte size cap/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid JSON", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-json-"));
    try {
      const filePath = path.join(dir, "windows.json");
      await fs.writeFile(filePath, "{not-json", "utf8");
      const outcome = await loadPlatformArtifact(filePath, "windows");
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.match(outcome.reason, /invalid JSON/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a document that fails schema validation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-schema-"));
    try {
      const filePath = path.join(dir, "ubuntu.json");
      await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 2, kind: "platform-run" }), "utf8");
      const outcome = await loadPlatformArtifact(filePath, "ubuntu");
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.match(outcome.reason, /failed schema validation/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a platform label that does not match the expected platform", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-mismatch-"));
    try {
      const filePath = path.join(dir, "partial.json");
      const ubuntu = validPlatformDocument("ubuntu", [target("alpha", { steps: [evidenceStep("kept")] })]);
      await fs.writeFile(filePath, JSON.stringify(ubuntu), "utf8");

      const matched = await loadPlatformArtifact(filePath, "ubuntu");
      assert.equal(matched.ok, true);
      if (!matched.ok) return;
      assert.equal(matched.document.platform, "ubuntu");
      assert.equal(matched.document.targets[0].steps[0].stdout, "kept");

      const mismatched = await loadPlatformArtifact(filePath, "windows");
      assert.equal(mismatched.ok, false);
      if (mismatched.ok) return;
      assert.match(mismatched.reason, /expected "windows"/);
      assert.match(mismatched.reason, /got "ubuntu"/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("status precedence", () => {
  it("computes aggregate status with failed, then infra_error, then not_run, then passed", () => {
    const pairs: Array<[PlatformTargetStatus, PlatformTargetStatus, AggregateTargetStatus]> = [
      ["passed", "passed", "passed"],
      ["passed", "failed", "failed"],
      ["failed", "passed", "failed"],
      ["failed", "infra_error", "failed"],
      ["infra_error", "failed", "failed"],
      ["passed", "infra_error", "infra_error"],
      ["infra_error", "passed", "infra_error"],
      ["passed", "not_run", "incomplete"],
      ["not_run", "passed", "incomplete"],
    ];
    for (const [ubuntu, windows, expected] of pairs) {
      assert.equal(
        computeAggregateStatus({
          ubuntu: { status: ubuntu },
          windows: { status: windows },
        }),
        expected,
        `${ubuntu} + ${windows}`,
      );
    }
  });

  it("computes overall status with the same precedence across targets", () => {
    const pairs: Array<[AggregateTargetStatus, AggregateTargetStatus, AggregateTargetStatus]> = [
      ["passed", "passed", "passed"],
      ["passed", "failed", "failed"],
      ["failed", "infra_error", "failed"],
      ["passed", "infra_error", "infra_error"],
      ["passed", "incomplete", "incomplete"],
    ];
    for (const [left, right, expected] of pairs) {
      assert.equal(
        computeOverallStatus([{ aggregateStatus: left }, { aggregateStatus: right }]),
        expected,
        `${left} + ${right}`,
      );
    }
  });
});

describe("mergePlatformRuns", () => {
  it("synthesizes infra_error for every catalog target when the Windows artifact is missing", () => {
    const doc = mergeOutcomes(["alpha", "beta"], {
      ubuntu: [
        target("alpha", { resolvedVersion: "1.0.0", steps: [evidenceStep("ubuntu-alpha")] }),
        target("beta", { resolvedVersion: "2.0.0", steps: [evidenceStep("ubuntu-beta")] }),
      ],
      windows: "Platform artifact is missing for windows.",
    });

    assert.equal(doc.platforms.ubuntu.runStatus, "complete");
    assert.equal(doc.platforms.ubuntu.environment?.osName, "Ubuntu");
    assert.equal(doc.platforms.windows.runStatus, "infra_error");
    assert.equal(doc.platforms.windows.environment, null);
    assert.equal(doc.platforms.windows.generatedAt, null);
    assert.match(doc.platforms.windows.note ?? "", /windows/);
    assert.equal(doc.overallStatus, "infra_error");
    assert.deepEqual(
      doc.targets.map((row) => row.id),
      ["alpha", "beta"],
    );

    for (const row of doc.targets) {
      assert.equal(row.results.windows.status, "infra_error");
      assert.equal(row.results.windows.failureCategory, "environment_failed");
      assert.equal(row.results.windows.resolvedVersion, null);
      assert.equal(row.results.windows.steps.length, 0);
      assert.equal(row.results.windows.checkedAt, CHECKED_AT);
      assert.equal(row.results.ubuntu.status, "passed");
      assert.equal(row.results.ubuntu.steps[0]?.stdout, `ubuntu-${row.id}`);
      assert.equal(row.aggregateStatus, "infra_error");
    }
    assert.equal(doc.targets[0].results.ubuntu.resolvedVersion, "1.0.0");
    assert.equal(doc.targets[1].results.ubuntu.resolvedVersion, "2.0.0");
    assert.deepEqual(doc.summary, countSummary(doc));
    assert.deepEqual(doc.summary, {
      targets: 2,
      passed: 0,
      failed: 0,
      infraErrors: 2,
      incomplete: 0,
      platformChecks: 4,
      platformPassed: 2,
      platformFailed: 0,
      platformInfraErrors: 2,
      platformNotRun: 0,
    });
  });

  it("synthesizes infra_error for every catalog target when the Ubuntu artifact is missing", () => {
    const doc = mergeOutcomes(["alpha", "beta"], {
      ubuntu: "Platform artifact is missing for ubuntu.",
      windows: [
        target("alpha", { resolvedVersion: "3.1.0", steps: [evidenceStep("windows-alpha")] }),
        target("beta", { resolvedVersion: "3.2.0", steps: [evidenceStep("windows-beta")] }),
      ],
    });

    assert.equal(doc.platforms.windows.runStatus, "complete");
    assert.equal(doc.platforms.windows.environment?.osName, "Windows");
    assert.equal(doc.platforms.ubuntu.runStatus, "infra_error");
    assert.equal(doc.platforms.ubuntu.environment, null);
    assert.match(doc.platforms.ubuntu.note ?? "", /ubuntu/);
    assert.equal(doc.overallStatus, "infra_error");

    for (const row of doc.targets) {
      assert.equal(row.results.ubuntu.status, "infra_error");
      assert.equal(row.results.ubuntu.steps.length, 0);
      assert.equal(row.results.ubuntu.resolvedVersion, null);
      assert.equal(row.results.windows.status, "passed");
      assert.equal(row.results.windows.steps[0]?.stdout, `windows-${row.id}`);
      assert.equal(row.aggregateStatus, "infra_error");
    }
    assert.equal(doc.targets[0].results.windows.resolvedVersion, "3.1.0");
    assert.equal(doc.targets[1].results.windows.resolvedVersion, "3.2.0");
    assert.deepEqual(doc.summary, countSummary(doc));
  });

  it("marks a target missing from a valid partial as not_run and incomplete", () => {
    const doc = mergeOutcomes(["alpha", "beta"], {
      ubuntu: [target("alpha", { resolvedVersion: "1.0.0", steps: [evidenceStep("alpha-only")] })],
      windows: [
        target("alpha", { resolvedVersion: "1.0.0" }),
        target("beta", { resolvedVersion: "1.0.0", steps: [evidenceStep("beta-windows")] }),
      ],
    });

    const alpha = doc.targets.find((row) => row.id === "alpha");
    const beta = doc.targets.find((row) => row.id === "beta");
    assert.ok(alpha);
    assert.ok(beta);
    assert.equal(alpha.aggregateStatus, "passed");
    assert.equal(alpha.results.ubuntu.steps[0]?.stdout, "alpha-only");
    assert.equal(beta.results.ubuntu.status, "not_run");
    assert.match(beta.results.ubuntu.notRunReason ?? "", /beta/);
    assert.match(beta.results.ubuntu.notRunReason ?? "", /ubuntu/);
    assert.equal(beta.results.windows.status, "passed");
    assert.equal(beta.results.windows.steps[0]?.stdout, "beta-windows");
    assert.equal(beta.aggregateStatus, "incomplete");
    assert.equal(doc.overallStatus, "incomplete");
    assert.equal(doc.summary.incomplete, 1);
    assert.equal(doc.summary.platformNotRun, 1);
    assert.deepEqual(doc.summary, countSummary(doc));
  });

  it("emits targets in catalog order when partial artifact targets are reversed", () => {
    const ids = ["alpha", "beta", "gamma"] as const;
    const reversed = [...ids].reverse().map((id) => target(id, { resolvedVersion: "1.0.0" }));
    const doc = mergeOutcomes(ids, { ubuntu: reversed, windows: [...reversed] });
    assert.deepEqual(
      doc.targets.map((row) => row.id),
      [...ids],
    );
  });

  it("never lets an unknown target id from a partial artifact enter the final status", () => {
    const doc = mergeOutcomes(["alpha", "beta"], {
      ubuntu: [target("rogue-target", { resolvedVersion: "9.9.9" }), target("beta"), target("alpha")],
      windows: [target("alpha"), target("rogue-target", { resolvedVersion: "9.9.9" }), target("beta")],
    });
    assert.deepEqual(
      doc.targets.map((row) => row.id),
      ["alpha", "beta"],
    );
    assert.equal(JSON.stringify(doc).includes("rogue-target"), false);
    assert.equal(doc.summary.targets, 2);
    assert.equal(doc.summary.platformChecks, 4);
  });

  it("sets versionDrift only when both resolved versions exist and differ", () => {
    const doc = mergeOutcomes(["differ", "equal", "ubuntu-only", "neither"], {
      ubuntu: [
        target("differ", { resolvedVersion: "1.0.0" }),
        target("equal", { resolvedVersion: "2.0.0" }),
        target("ubuntu-only", { resolvedVersion: "3.0.0" }),
        target("neither", { resolvedVersion: null }),
      ],
      windows: [
        target("differ", { resolvedVersion: "1.0.1" }),
        target("equal", { resolvedVersion: "2.0.0" }),
        target("ubuntu-only", { status: "not_run", resolvedVersion: null }),
        target("neither", { status: "infra_error", resolvedVersion: null }),
      ],
    });
    assert.deepEqual(
      Object.fromEntries(doc.targets.map((row) => [row.id, row.versionDrift])),
      {
        differ: true,
        equal: false,
        "ubuntu-only": false,
        neither: false,
      },
    );
  });

  it("summary counts match target and platform statuses exactly", () => {
    const doc = mergeOutcomes(["alpha", "beta", "gamma", "delta"], {
      ubuntu: [
        target("delta", { resolvedVersion: "5.0.0" }),
        target("gamma", { resolvedVersion: "4.0.0" }),
        target("beta", { status: "failed", resolvedVersion: "1.0.0" }),
        target("alpha", { resolvedVersion: "1.0.0" }),
      ],
      windows: [
        target("alpha", { resolvedVersion: "1.0.0" }),
        target("beta", { resolvedVersion: "1.1.0" }),
        target("gamma", { status: "infra_error", resolvedVersion: null }),
        target("rogue-target", { resolvedVersion: "9.9.9" }),
      ],
    });

    assert.deepEqual(
      doc.targets.map((row) => [
        row.id,
        row.aggregateStatus,
        row.versionDrift,
        row.results.ubuntu.status,
        row.results.windows.status,
      ]),
      [
        ["alpha", "passed", false, "passed", "passed"],
        ["beta", "failed", true, "failed", "passed"],
        ["gamma", "infra_error", false, "passed", "infra_error"],
        ["delta", "incomplete", false, "passed", "not_run"],
      ],
    );
    assert.equal(doc.overallStatus, "failed");
    assert.equal(doc.overallStatus, computeOverallStatus(doc.targets));
    assert.equal(JSON.stringify(doc).includes("rogue-target"), false);
    assert.deepEqual(doc.summary, countSummary(doc));
    assert.deepEqual(doc.summary, {
      targets: 4,
      passed: 1,
      failed: 1,
      infraErrors: 1,
      incomplete: 1,
      platformChecks: 8,
      platformPassed: 5,
      platformFailed: 1,
      platformInfraErrors: 1,
      platformNotRun: 1,
    });
    assert.equal(AggregateStatusDocumentSchema.safeParse(doc).success, true);
  });
});

describe("badges", () => {
  it("maps overall status to shields colors", () => {
    const cases: Array<{
      ids: readonly string[];
      ubuntu: PlatformPartialTarget[];
      windows: PlatformPartialTarget[];
      color: ShieldsEndpointBadge["color"];
      message: string;
    }> = [
      {
        ids: ["alpha"],
        ubuntu: [target("alpha", { resolvedVersion: "1.2.3" })],
        windows: [target("alpha", { resolvedVersion: "1.2.3" })],
        color: "green",
        message: "2/2 checks pass",
      },
      {
        ids: ["alpha"],
        ubuntu: [target("alpha", { status: "passed", resolvedVersion: "1.2.3" })],
        windows: [target("alpha", { status: "failed", resolvedVersion: "1.2.3" })],
        color: "red",
        message: "1 failed, 1 passed",
      },
      {
        ids: ["alpha"],
        ubuntu: [target("alpha", { status: "passed", resolvedVersion: "1.2.3" })],
        windows: [target("alpha", { status: "infra_error" })],
        color: "orange",
        message: "1 infra error, 1 passed",
      },
      {
        ids: ["alpha"],
        ubuntu: [target("alpha", { status: "passed", resolvedVersion: "1.2.3" })],
        windows: [target("other", { status: "passed", resolvedVersion: "1.2.3" })],
        color: "lightgrey",
        message: "1 incomplete, 1 passed",
      },
    ];

    for (const entry of cases) {
      const doc = mergeOutcomes(entry.ids, { ubuntu: entry.ubuntu, windows: entry.windows });
      const badge = generateBadges(doc).get("overall.json");
      assert.ok(badge);
      assert.equal(badge.color, entry.color, entry.color);
      assert.equal(badge.message, entry.message);
      assert.equal(ShieldsEndpointSchema.safeParse(badge).success, true);
    }
  });

  it("lets a functional failure take precedence over infra_error", () => {
    const doc = mergeOutcomes(["payments", "auth"], {
      ubuntu: [
        target("payments", { status: "failed", resolvedVersion: "1.0.0" }),
        target("auth", { status: "infra_error" }),
      ],
      windows: [
        target("payments", { status: "passed", resolvedVersion: "1.0.0" }),
        target("auth", { status: "passed", resolvedVersion: "2.0.0" }),
      ],
    });
    assert.equal(doc.overallStatus, "failed");
    assert.equal(doc.targets.find((row) => row.id === "payments")?.aggregateStatus, "failed");
    assert.equal(doc.targets.find((row) => row.id === "auth")?.aggregateStatus, "infra_error");

    const badges = generateBadges(doc);
    assert.equal(badges.get("overall.json")?.color, "red");
    assert.equal(badges.get("overall.json")?.message, "1 failed, 2 passed");
    assert.equal(badges.get("payments-ubuntu.json")?.color, "red");
    assert.equal(badges.get("auth-ubuntu.json")?.color, "orange");
    assert.equal(badges.get("auth-windows.json")?.color, "green");
  });

  it("generates one overall badge and two platform badges per target", () => {
    const longId = "a".repeat(64);
    const longVersion = `1.2.3-${"b".repeat(58)}`;
    assert.equal(longId.length, 64);
    assert.equal(longVersion.length, 64);

    const ids = ["alpha", "beta", longId] as const;
    const doc = mergeOutcomes(ids, {
      ubuntu: [
        target("alpha", { resolvedVersion: "1.2.3" }),
        target("beta", { status: "failed", resolvedVersion: "0.1.0" }),
        target(longId, { resolvedVersion: longVersion }),
      ],
      windows: [
        target("alpha", { resolvedVersion: "1.2.3" }),
        target("beta", { status: "not_run", resolvedVersion: null }),
        target(longId, { resolvedVersion: longVersion }),
      ],
    });

    const badges = generateBadges(doc);
    assert.equal(badges.size, 1 + ids.length * 2);
    assert.deepEqual(
      [...badges.keys()].sort(),
      [
        "overall.json",
        "alpha-ubuntu.json",
        "alpha-windows.json",
        "beta-ubuntu.json",
        "beta-windows.json",
        `${longId}-ubuntu.json`,
        `${longId}-windows.json`,
      ].sort(),
    );

    for (const [filename, badge] of badges) {
      assert.match(filename, /^[a-z0-9][a-z0-9_-]{0,80}\.json$/);
      const parsed = ShieldsEndpointSchema.parse(badge);
      assert.ok(parsed.label.length >= 1 && parsed.label.length <= 64);
      assert.ok(parsed.message.length >= 1 && parsed.message.length <= 64);
      assert.equal(parsed.schemaVersion, 1);
    }

    assert.equal(badges.get("overall.json")?.label, "docrun");
    assert.equal(badges.get("alpha-ubuntu.json")?.label, "alpha (ubuntu)");
    assert.equal(badges.get("alpha-ubuntu.json")?.message, "pass (1.2.3)");
    assert.equal(badges.get("beta-ubuntu.json")?.message, "fail (0.1.0)");
    assert.equal(badges.get("beta-windows.json")?.message, "not run");
    assert.equal(badges.get("beta-windows.json")?.color, "lightgrey");

    const longBadge = badges.get(`${longId}-ubuntu.json`);
    assert.ok(longBadge);
    assert.equal(longBadge.label.length, 64);
    assert.equal(longBadge.message.length, 64);
    assert.equal(longBadge.label.endsWith("…"), true);
    assert.equal(longBadge.message.endsWith("…"), true);
  });

  it("writes valid badge files and rejects unsafe filenames", async () => {
    const doc = mergeOutcomes(["alpha"], {
      ubuntu: [target("alpha")],
      windows: [target("alpha")],
    });
    const badges = generateBadges(doc);
    const overall = badges.get("overall.json");
    assert.ok(overall);

    const mutated = structuredClone(doc);
    mutated.targets[0].id = "../evil";
    assert.throws(() => generateBadges(mutated), /Unsafe target slug for badge filename/);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-badges-"));
    try {
      const badgesDir = path.join(root, "badges");
      await writeBadges(badgesDir, badges);
      const written = ShieldsEndpointSchema.parse(
        JSON.parse(await fs.readFile(path.join(badgesDir, "overall.json"), "utf8")),
      );
      assert.equal(written.color, "green");
      assert.equal(written.label, "docrun");
      assert.ok((await fs.readdir(badgesDir)).includes("alpha-ubuntu.json"));
      assert.ok((await fs.readdir(badgesDir)).includes("alpha-windows.json"));

      const unsafeNames = [
        "../evil.json",
        "..\\evil.json",
        "Overall.json",
        "a/b.json",
        "bad name.json",
        ".json",
        "overall.json.",
      ];
      for (const filename of unsafeNames) {
        await assert.rejects(
          () => writeBadges(badgesDir, new Map([[filename, overall]])),
          /Refusing to write unsafe badge filename/,
          filename,
        );
      }

      assert.deepEqual(await fs.readdir(root), ["badges"]);
      const writtenNames = await fs.readdir(badgesDir);
      assert.equal(writtenNames.includes("evil.json"), false);
      assert.equal(writtenNames.includes("..\\evil.json"), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("hardening regressions", () => {
  it("rejects platform artifacts whose summary counts disagree with targets", () => {
    const doc = validPlatformDocument("ubuntu", [target("alpha", { status: "passed" })]);
    const tampered = {
      ...doc,
      summary: { total: 1, passed: 0, failed: 1, infraErrors: 0, notRun: 0 },
    };
    const parsed = PlatformRunDocumentSchema.safeParse(tampered);
    assert.equal(parsed.success, false);
  });

  it("cleans metadata values without injecting multi-line truncation markers", () => {
    const longOs = `Windows\n\tServer ${"x".repeat(200)} C:\\Users\\alice\\secret`;
    const cleaned = cleanMetadataValue(longOs, 64, "fallback");
    assert.ok(cleaned.length <= 64);
    assert.doesNotMatch(cleaned, /\[truncated/);
    assert.doesNotMatch(cleaned, /[\r\n\t]/);
    assert.doesNotMatch(cleaned, /alice/);
    assert.equal(cleanMetadataValue("   \n\t  ", 32, "fallback"), "fallback");
  });

  it("rejects symlinked platform artifacts", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-symlink-"));
    try {
      const realPath = path.join(dir, "real.json");
      const linkPath = path.join(dir, "link.json");
      await fs.writeFile(
        realPath,
        JSON.stringify(validPlatformDocument("ubuntu", [target("alpha")])),
        "utf8",
      );
      try {
        await fs.symlink(realPath, linkPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("Host OS does not allow unprivileged symlinks.");
          return;
        }
        throw err;
      }

      const outcome = await loadPlatformArtifact(linkPath, "ubuntu");
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.match(outcome.reason, /regular file/);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write status site to filesystem root", async () => {
    const rootDir = path.parse(process.cwd()).root;
    await assert.rejects(
      () =>
        buildStatusSite({
          siteSrcDir: path.join(process.cwd(), "site"),
          statusJsonPath: path.join(process.cwd(), "catalog", "targets.json"),
          outDir: rootDir,
        }),
      /filesystem root/,
    );
  });
});

