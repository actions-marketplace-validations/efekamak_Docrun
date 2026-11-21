import * as z from "zod/v4";
import { FAILURE_CATEGORIES, isSafeRelativePath } from "../bot/lib/contract.js";
import { CATALOG_LIMITS } from "./catalog-limits.js";

export const REQUIRED_PLATFORMS = ["ubuntu", "windows"] as const;
export type PlatformId = (typeof REQUIRED_PLATFORMS)[number];

export const PLATFORM_TARGET_STATUSES = ["passed", "failed", "infra_error", "not_run"] as const;
export type PlatformTargetStatus = (typeof PLATFORM_TARGET_STATUSES)[number];

export const AGGREGATE_TARGET_STATUSES = [
  "passed",
  "failed",
  "infra_error",
  "incomplete",
] as const;
export type AggregateTargetStatus = (typeof AGGREGATE_TARGET_STATUSES)[number];

export const PLATFORM_RUN_STATES = ["complete", "infra_error"] as const;
export type PlatformRunState = (typeof PLATFORM_RUN_STATES)[number];

const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NPM_PACKAGE_REGEX = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const COMMIT_SHA_REGEX = /^[0-9a-f]{7,40}$/i;
const FINGERPRINT_REGEX = /^[0-9a-f]{16}$/;
const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidIsoDatetime(candidate: string): boolean {
  if (!ISO_DATETIME_REGEX.test(candidate)) {
    return false;
  }
  const ts = Date.parse(candidate);
  return Number.isFinite(ts);
}

function isHttpsUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

export const IsoDateTimeSchema = z.string().refine(isValidIsoDatetime, {
  message: "Must be a valid ISO-8601 timestamp.",
});

export const CommitShaSchema = z.string().regex(COMMIT_SHA_REGEX, {
  message: "Must be a 7-40 character hexadecimal commit SHA.",
});

export const HttpsUrlSchema = z.string().refine(isHttpsUrl, {
  message: "URL must use https:// with a valid hostname.",
});

export const PlatformIdSchema = z.enum(REQUIRED_PLATFORMS);
export const PlatformTargetStatusSchema = z.enum(PLATFORM_TARGET_STATUSES);
export const AggregateTargetStatusSchema = z.enum(AGGREGATE_TARGET_STATUSES);
export const PlatformRunStateSchema = z.enum(PLATFORM_RUN_STATES);

export const PlatformEnvironmentSchema = z
  .object({
    osName: z.string().min(1).max(64),
    osVersion: z.string().min(1).max(120),
    osRelease: z.string().min(1).max(64),
    arch: z.string().min(1).max(32),
    nodeVersion: z.string().min(1).max(32),
    npmVersion: z.string().min(1).max(32),
    runnerImage: z.string().min(1).max(64).nullable(),
  })
  .strict();

export type PlatformEnvironment = z.infer<typeof PlatformEnvironmentSchema>;

export const AssertionResultSchema = z
  .object({
    kind: z.enum(["exitCode", "stdoutIncludes", "stderrIncludes", "filesExist"]),
    expected: z.string().max(1024),
    observed: z.string().max(1024),
    passed: z.boolean(),
  })
  .strict();

export const PublicStepEvidenceSchema = z
  .object({
    id: z.string().regex(SLUG_REGEX),
    command: z.enum(["node", "npm"]),
    args: z.array(z.string().max(512)).max(50),
    status: z.enum(["passed", "failed", "timed_out", "skipped"]),
    failureCategory: z.enum(FAILURE_CATEGORIES).nullable(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    assertions: z.array(AssertionResultSchema).max(50),
    stdout: z.string().max(CATALOG_LIMITS.PUBLIC_EXCERPT_BYTES + 256),
    stderr: z.string().max(CATALOG_LIMITS.PUBLIC_EXCERPT_BYTES + 256),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
  })
  .strict();

type PublicStepEvidence = z.infer<typeof PublicStepEvidenceSchema>;

export const PlatformTargetResultSchema = z
  .object({
    status: PlatformTargetStatusSchema,
    resolvedVersion: z.string().min(1).max(64).nullable(),
    checkedAt: IsoDateTimeSchema,
    durationMs: z.number().int().nonnegative(),
    firstFailedStepId: z.string().regex(SLUG_REGEX).nullable(),
    failureCategory: z.enum(FAILURE_CATEGORIES).nullable(),
    fingerprint: z.string().regex(FINGERPRINT_REGEX).nullable(),
    notRunReason: z.string().min(1).max(512).nullable(),
    infraErrorMessage: z.string().min(1).max(512).nullable(),
    steps: z.array(PublicStepEvidenceSchema).max(20),
  })
  .strict();

export type PlatformTargetResult = z.infer<typeof PlatformTargetResultSchema>;

export const PlatformPartialTargetSchema = PlatformTargetResultSchema.extend({
  id: z.string().regex(SLUG_REGEX),
}).strict();

export type PlatformPartialTarget = z.infer<typeof PlatformPartialTargetSchema>;

export const PlatformRunSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    infraErrors: z.number().int().nonnegative(),
    notRun: z.number().int().nonnegative(),
  })
  .strict();

export type PlatformRunSummary = z.infer<typeof PlatformRunSummarySchema>;

export const PlatformRunDocumentSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal("platform-run"),
    platform: PlatformIdSchema,
    generatedAt: IsoDateTimeSchema,
    sourceCommit: CommitShaSchema.nullable(),
    environment: PlatformEnvironmentSchema,
    summary: PlatformRunSummarySchema,
    targets: z.array(PlatformPartialTargetSchema).min(1).max(CATALOG_LIMITS.MAX_TARGETS),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < doc.targets.length; i += 1) {
      const id = doc.targets[i].id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", i, "id"],
          message: `Duplicate target id in platform artifact: "${id}".`,
        });
      }
      seen.add(id);
    }

    const expectedSummary = summarizePlatformRun(doc.targets);
    if (
      doc.summary.total !== expectedSummary.total ||
      doc.summary.passed !== expectedSummary.passed ||
      doc.summary.failed !== expectedSummary.failed ||
      doc.summary.infraErrors !== expectedSummary.infraErrors ||
      doc.summary.notRun !== expectedSummary.notRun
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["summary"],
        message: "Platform artifact summary counts do not match target results.",
      });
    }
  });

export type PlatformRunDocument = z.infer<typeof PlatformRunDocumentSchema>;

export const PlatformRunOverviewSchema = z
  .object({
    runStatus: PlatformRunStateSchema,
    generatedAt: IsoDateTimeSchema.nullable(),
    environment: PlatformEnvironmentSchema.nullable(),
    note: z.string().min(1).max(240).nullable(),
  })
  .strict();

export type PlatformRunOverview = z.infer<typeof PlatformRunOverviewSchema>;

export const AggregateTargetSchema = z
  .object({
    id: z.string().regex(SLUG_REGEX),
    name: z.string().min(1).max(80),
    package: z.string().regex(NPM_PACKAGE_REGEX),
    scope: z.string().min(3).max(120),
    docsUrl: HttpsUrlSchema,
    repositoryUrl: HttpsUrlSchema,
    contractPath: z.string().min(1).refine(isSafeRelativePath, {
      message: "contractPath must stay inside the repository.",
    }),
    aggregateStatus: AggregateTargetStatusSchema,
    versionDrift: z.boolean(),
    results: z
      .object({
        ubuntu: PlatformTargetResultSchema,
        windows: PlatformTargetResultSchema,
      })
      .strict(),
  })
  .strict();

export type AggregateTarget = z.infer<typeof AggregateTargetSchema>;

export const AggregateSummarySchema = z
  .object({
    targets: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    infraErrors: z.number().int().nonnegative(),
    incomplete: z.number().int().nonnegative(),
    platformChecks: z.number().int().nonnegative(),
    platformPassed: z.number().int().nonnegative(),
    platformFailed: z.number().int().nonnegative(),
    platformInfraErrors: z.number().int().nonnegative(),
    platformNotRun: z.number().int().nonnegative(),
  })
  .strict();

export type AggregateSummary = z.infer<typeof AggregateSummarySchema>;

export const AggregateStatusDocumentSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal("aggregate-status"),
    generatedAt: IsoDateTimeSchema,
    sourceCommit: CommitShaSchema.nullable(),
    requiredPlatforms: z.tuple([z.literal("ubuntu"), z.literal("windows")]),
    overallStatus: AggregateTargetStatusSchema,
    summary: AggregateSummarySchema,
    platforms: z
      .object({
        ubuntu: PlatformRunOverviewSchema,
        windows: PlatformRunOverviewSchema,
      })
      .strict(),
    targets: z.array(AggregateTargetSchema).min(1).max(CATALOG_LIMITS.MAX_TARGETS),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < doc.targets.length; i += 1) {
      const id = doc.targets[i].id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", i, "id"],
          message: `Duplicate target id in aggregate status: "${id}".`,
        });
      }
      seen.add(id);
    }
  });

export type AggregateStatusDocument = z.infer<typeof AggregateStatusDocumentSchema>;

/**
 * Single source of truth for per-target aggregate status precedence:
 * 1. Any functional failure ("failed") -> "failed"
 * 2. Else any infra error ("infra_error") -> "infra_error"
 * 3. Else any not_run / missing -> "incomplete"
 * 4. Only if all required platforms passed -> "passed"
 */
export function computeAggregateStatus(
  results: Record<PlatformId, { status: PlatformTargetStatus }>,
): AggregateTargetStatus {
  const statuses = REQUIRED_PLATFORMS.map((p) => results[p].status);
  if (statuses.includes("failed")) {
    return "failed";
  }
  if (statuses.includes("infra_error")) {
    return "infra_error";
  }
  if (statuses.includes("not_run")) {
    return "incomplete";
  }
  return "passed";
}

/**
 * Single source of truth for run-level overall status precedence.
 */
export function computeOverallStatus(
  targets: Array<{ aggregateStatus: AggregateTargetStatus }>,
): AggregateTargetStatus {
  if (targets.length === 0) {
    return "incomplete";
  }
  if (targets.some((t) => t.aggregateStatus === "failed")) {
    return "failed";
  }
  if (targets.some((t) => t.aggregateStatus === "infra_error")) {
    return "infra_error";
  }
  if (targets.some((t) => t.aggregateStatus === "incomplete")) {
    return "incomplete";
  }
  return "passed";
}

export function computeVersionDrift(
  ubuntuVersion: string | null,
  windowsVersion: string | null,
): boolean {
  return Boolean(ubuntuVersion && windowsVersion && ubuntuVersion !== windowsVersion);
}

export function summarizePlatformRun(
  targets: Array<{ status: PlatformTargetStatus }>,
): PlatformRunSummary {
  let passed = 0;
  let failed = 0;
  let infraErrors = 0;
  let notRun = 0;
  for (const t of targets) {
    if (t.status === "passed") passed += 1;
    else if (t.status === "failed") failed += 1;
    else if (t.status === "infra_error") infraErrors += 1;
    else if (t.status === "not_run") notRun += 1;
  }
  return {
    total: targets.length,
    passed,
    failed,
    infraErrors,
    notRun,
  };
}

export function summarizeAggregateTargets(targets: AggregateTarget[]): AggregateSummary {
  let passed = 0;
  let failed = 0;
  let infraErrors = 0;
  let incomplete = 0;
  let platformChecks = 0;
  let platformPassed = 0;
  let platformFailed = 0;
  let platformInfraErrors = 0;
  let platformNotRun = 0;

  for (const target of targets) {
    if (target.aggregateStatus === "passed") passed += 1;
    else if (target.aggregateStatus === "failed") failed += 1;
    else if (target.aggregateStatus === "infra_error") infraErrors += 1;
    else if (target.aggregateStatus === "incomplete") incomplete += 1;

    for (const platform of REQUIRED_PLATFORMS) {
      const pStatus = target.results[platform].status;
      platformChecks += 1;
      if (pStatus === "passed") platformPassed += 1;
      else if (pStatus === "failed") platformFailed += 1;
      else if (pStatus === "infra_error") platformInfraErrors += 1;
      else if (pStatus === "not_run") platformNotRun += 1;
    }
  }

  return {
    targets: targets.length,
    passed,
    failed,
    infraErrors,
    incomplete,
    platformChecks,
    platformPassed,
    platformFailed,
    platformInfraErrors,
    platformNotRun,
  };
}

export function toPlatformPartialTarget(
  targetId: string,
  result: {
    status: PlatformTargetStatus;
    resolvedVersion: string | null;
    checkedAt: string;
    durationMs: number;
    firstFailedStepId: string | null;
    failureCategory: PlatformTargetResult["failureCategory"];
    fingerprint: string | null;
    notRunReason: string | null;
    infraErrorMessage: string | null;
    steps: PublicStepEvidence[];
  },
): PlatformPartialTarget {
  return {
    id: targetId,
    status: result.status,
    resolvedVersion: result.resolvedVersion,
    checkedAt: result.checkedAt,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    firstFailedStepId: result.firstFailedStepId,
    failureCategory: result.failureCategory,
    fingerprint: result.fingerprint,
    notRunReason: result.notRunReason,
    infraErrorMessage: result.infraErrorMessage,
    steps: result.steps.map((s) => ({
      ...s,
      durationMs: Math.max(0, Math.round(s.durationMs)),
    })),
  };
}
