import * as fs from "node:fs/promises";
import type { CatalogDocument, CatalogTarget } from "./catalog-lib.js";
import { sanitizePublicExcerpt } from "./catalog-lib.js";
import {
  AggregateStatusDocumentSchema,
  PlatformRunDocumentSchema,
  REQUIRED_PLATFORMS,
  computeAggregateStatus,
  computeOverallStatus,
  computeVersionDrift,
  summarizeAggregateTargets,
  type AggregateStatusDocument,
  type AggregateTarget,
  type PlatformId,
  type PlatformRunDocument,
  type PlatformRunOverview,
  type PlatformTargetResult,
} from "./status-v2.js";

export const MAX_PLATFORM_ARTIFACT_BYTES = 5 * 1024 * 1024; // 5 MiB hard cap

export type PlatformArtifactLoadOutcome =
  | {
      ok: true;
      document: PlatformRunDocument;
    }
  | {
      ok: false;
      reason: string;
    };

export async function loadPlatformArtifact(
  filePath: string | null | undefined,
  expectedPlatform: PlatformId,
  options?: {
    jobResult?: string | null;
    maxBytes?: number;
  },
): Promise<PlatformArtifactLoadOutcome> {
  const maxBytes = options?.maxBytes ?? MAX_PLATFORM_ARTIFACT_BYTES;
  const jobResult = options?.jobResult?.trim() || null;

  if (!filePath) {
    return {
      ok: false,
      reason: formatMissingArtifactMessage(expectedPlatform, jobResult, "Artifact path was not provided."),
    };
  }

  let lstat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    lstat = await fs.lstat(filePath);
  } catch {
    return {
      ok: false,
      reason: formatMissingArtifactMessage(expectedPlatform, jobResult, "Platform artifact is missing."),
    };
  }

  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    return {
      ok: false,
      reason: formatMissingArtifactMessage(expectedPlatform, jobResult, "Platform artifact is not a regular file."),
    };
  }

  if (lstat.size > maxBytes) {
    return {
      ok: false,
      reason: `Platform artifact for ${expectedPlatform} exceeded the ${maxBytes}-byte size cap.`,
    };
  }

  let rawText: string;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const fstat = await handle.stat();
    if (!fstat.isFile()) {
      return {
        ok: false,
        reason: formatMissingArtifactMessage(expectedPlatform, jobResult, "Platform artifact is not a regular file."),
      };
    }
    if (fstat.size > maxBytes) {
      return {
        ok: false,
        reason: `Platform artifact for ${expectedPlatform} exceeded the ${maxBytes}-byte size cap.`,
      };
    }
    const buf = Buffer.alloc(fstat.size);
    let offset = 0;
    while (offset < fstat.size) {
      const { bytesRead } = await handle.read(buf, offset, fstat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    rawText = buf.subarray(0, offset).toString("utf8");
  } catch {
    return {
      ok: false,
      reason: formatMissingArtifactMessage(expectedPlatform, jobResult, "Platform artifact could not be read."),
    };
  } finally {
    await handle?.close().catch(() => {});
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      reason: `Platform artifact for ${expectedPlatform} contained invalid JSON.`,
    };
  }

  const parsed = PlatformRunDocumentSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Platform artifact for ${expectedPlatform} failed schema validation.`,
    };
  }

  if (parsed.data.platform !== expectedPlatform) {
    return {
      ok: false,
      reason: `Platform artifact mismatch: expected "${expectedPlatform}" but got "${parsed.data.platform}".`,
    };
  }

  return {
    ok: true,
    document: parsed.data,
  };
}

function formatMissingArtifactMessage(
  platform: PlatformId,
  jobResult: string | null,
  fallback: string,
): string {
  const suffix =
    jobResult && /^[a-z0-9_-]{1,24}$/i.test(jobResult) && jobResult !== "success"
      ? ` (workflow job result: ${jobResult})`
      : "";
  return sanitizePublicExcerpt(`${fallback.replace(/\.$/, "")} for ${platform}${suffix}.`, 240).text;
}

export function synthesizeInfraErrorTarget(
  message: string,
  checkedAt: string,
): PlatformTargetResult {
  const cleanMessage = sanitizePublicExcerpt(message, 240).text || "Platform runner failed before producing results.";
  return {
    status: "infra_error",
    resolvedVersion: null,
    checkedAt,
    durationMs: 0,
    firstFailedStepId: null,
    failureCategory: "environment_failed",
    fingerprint: null,
    notRunReason: null,
    infraErrorMessage: cleanMessage,
    steps: [],
  };
}

export function synthesizeNotRunTarget(
  reason: string,
  checkedAt: string,
): PlatformTargetResult {
  const cleanReason = sanitizePublicExcerpt(reason, 240).text || "Target was not present in platform artifact.";
  return {
    status: "not_run",
    resolvedVersion: null,
    checkedAt,
    durationMs: 0,
    firstFailedStepId: null,
    failureCategory: null,
    fingerprint: null,
    notRunReason: cleanReason,
    infraErrorMessage: null,
    steps: [],
  };
}

function stripId(
  partialTarget: PlatformRunDocument["targets"][number],
): PlatformTargetResult {
  return {
    status: partialTarget.status,
    resolvedVersion: partialTarget.resolvedVersion,
    checkedAt: partialTarget.checkedAt,
    durationMs: partialTarget.durationMs,
    firstFailedStepId: partialTarget.firstFailedStepId,
    failureCategory: partialTarget.failureCategory,
    fingerprint: partialTarget.fingerprint,
    notRunReason: partialTarget.notRunReason,
    infraErrorMessage: partialTarget.infraErrorMessage,
    steps: partialTarget.steps,
  };
}

export type MergePlatformRunsInput = {
  catalog: CatalogDocument;
  platforms: Record<PlatformId, PlatformArtifactLoadOutcome>;
  sourceCommit: string | null;
  generatedAt?: string;
};

export function mergePlatformRuns(input: MergePlatformRunsInput): AggregateStatusDocument {
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  const platformOverviews = {} as Record<PlatformId, PlatformRunOverview>;
  const targetMaps = {} as Record<PlatformId, Map<string, PlatformTargetResult> | null>;
  const platformErrors = {} as Record<PlatformId, string | null>;

  for (const platform of REQUIRED_PLATFORMS) {
    const outcome = input.platforms[platform];
    if (outcome.ok) {
      const map = new Map<string, PlatformTargetResult>();
      for (const entry of outcome.document.targets) {
        map.set(entry.id, stripId(entry));
      }
      targetMaps[platform] = map;
      platformErrors[platform] = null;
      platformOverviews[platform] = {
        runStatus: "complete",
        generatedAt: outcome.document.generatedAt,
        environment: outcome.document.environment,
        note: null,
      };
    } else {
      targetMaps[platform] = null;
      platformErrors[platform] = outcome.reason;
      platformOverviews[platform] = {
        runStatus: "infra_error",
        generatedAt: null,
        environment: null,
        note: sanitizePublicExcerpt(outcome.reason, 240).text,
      };
    }
  }

  const targets: AggregateTarget[] = input.catalog.targets.map((catalogTarget: CatalogTarget) => {
    const results = {} as Record<PlatformId, PlatformTargetResult>;
    for (const platform of REQUIRED_PLATFORMS) {
      const map = targetMaps[platform];
      if (!map) {
        results[platform] = synthesizeInfraErrorTarget(
          platformErrors[platform] ?? `Platform artifact missing for ${platform}.`,
          generatedAt,
        );
      } else {
        const found = map.get(catalogTarget.id);
        results[platform] =
          found ??
          synthesizeNotRunTarget(
            `Target "${catalogTarget.id}" was missing from the ${platform} artifact.`,
            platformOverviews[platform].generatedAt ?? generatedAt,
          );
      }
    }

    const aggregateStatus = computeAggregateStatus(results);
    const versionDrift = computeVersionDrift(
      results.ubuntu.resolvedVersion,
      results.windows.resolvedVersion,
    );

    return {
      id: catalogTarget.id,
      name: catalogTarget.name,
      package: catalogTarget.package,
      scope: catalogTarget.scope,
      docsUrl: catalogTarget.docsUrl,
      repositoryUrl: catalogTarget.repositoryUrl,
      contractPath: catalogTarget.contractPath,
      aggregateStatus,
      versionDrift,
      results,
    };
  });

  const doc: AggregateStatusDocument = {
    schemaVersion: 2,
    kind: "aggregate-status",
    generatedAt,
    sourceCommit: input.sourceCommit,
    requiredPlatforms: ["ubuntu", "windows"],
    overallStatus: computeOverallStatus(targets),
    summary: summarizeAggregateTargets(targets),
    platforms: platformOverviews,
    targets,
  };

  return AggregateStatusDocumentSchema.parse(doc);
}
