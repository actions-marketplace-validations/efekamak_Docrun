import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as z from "zod/v4";
import {
  LIMITS,
  isSafeRelativePath,
  loadContractFile,
  resolveContainedPath,
  type FailureCategory,
  type QuickstartContract,
} from "../bot/lib/contract.js";
import {
  redactSecrets,
  runQuickstartContract,
  type AssertionResult,
  type QuickstartRunResult,
} from "../bot/lib/execute.js";
import { sanitizePublicExcerpt as sanitizeSharedPublicExcerpt } from "../bot/lib/public-output.js";
import { CATALOG_LIMITS } from "./catalog-limits.js";
import { ShieldsEndpointSchema, generateBadges, writeBadges } from "./badges.js";
import { HistoryDocumentSchema } from "./history.js";
import { collectPlatformEnvironment } from "./platform-metadata.js";
import {
  AggregateStatusDocumentSchema,
  PlatformRunDocumentSchema,
  summarizePlatformRun,
  toPlatformPartialTarget,
  type PlatformEnvironment,
  type PlatformId,
  type PlatformRunDocument,
} from "./status-v2.js";

export { CATALOG_LIMITS };

export const ALLOWED_CATALOG_NPM_SUBCOMMANDS = ["install", "list", "exec"] as const;

const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NPM_PACKAGE_REGEX = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function isHttpsUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

const HttpsUrlSchema = z.string().refine(isHttpsUrl, {
  message: "URL must use https:// with a valid hostname.",
});

export const CatalogTargetSchema = z
  .object({
    id: z.string().regex(SLUG_REGEX, "Target id must be a lowercase slug (a-z, 0-9, -, _)."),
    name: z.string().min(1).max(80),
    package: z
      .string()
      .regex(NPM_PACKAGE_REGEX, "Package must be a valid npm package name."),
    docsUrl: HttpsUrlSchema,
    repositoryUrl: HttpsUrlSchema,
    contractPath: z.string().min(1).refine(isSafeRelativePath, {
      message: "contractPath must stay inside the repository.",
    }),
    scope: z.string().min(3).max(120),
  })
  .strict();

export const CatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    targets: z.array(CatalogTargetSchema).min(1).max(CATALOG_LIMITS.MAX_TARGETS),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < catalog.targets.length; i += 1) {
      const id = catalog.targets[i].id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", i, "id"],
          message: `Duplicate target id: "${id}".`,
        });
      }
      seen.add(id);
    }
  });

export type CatalogTarget = z.infer<typeof CatalogTargetSchema>;
export type CatalogDocument = z.infer<typeof CatalogSchema>;

export type TargetStatus = "passed" | "failed" | "infra_error" | "not_run";

export type PublicStepEvidence = {
  id: string;
  command: "node" | "npm";
  args: string[];
  status: "passed" | "failed" | "timed_out" | "skipped";
  failureCategory: FailureCategory | null;
  exitCode: number | null;
  durationMs: number;
  assertions: AssertionResult[];
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type PublicTargetResult = {
  id: string;
  name: string;
  package: string;
  resolvedVersion: string | null;
  scope: string;
  status: TargetStatus;
  checkedAt: string;
  durationMs: number;
  firstFailedStepId: string | null;
  failureCategory: FailureCategory | null;
  fingerprint: string | null;
  notRunReason: string | null;
  infraErrorMessage: string | null;
  docsUrl: string;
  repositoryUrl: string;
  contractPath: string;
  steps: PublicStepEvidence[];
};

export type StatusDocument = {
  schemaVersion: 1;
  generatedAt: string;
  sourceCommit: string | null;
  summary: {
    total: number;
    passed: number;
    failed: number;
    infraErrors: number;
    notRun: number;
  };
  targets: PublicTargetResult[];
};

export type CatalogValidationOutcome =
  | {
      ok: true;
      catalog: CatalogDocument;
      contracts: Map<string, QuickstartContract>;
    }
  | {
      ok: false;
      errors: string[];
    };

export function validateCatalogContractPolicy(
  targetId: string,
  contract: QuickstartContract,
): string[] {
  const errors: string[] = [];
  for (const step of contract.steps) {
    if (step.command === "npm") {
      const subcommand = step.args[0];
      if (
        !subcommand ||
        !(ALLOWED_CATALOG_NPM_SUBCOMMANDS as readonly string[]).includes(subcommand)
      ) {
        errors.push(
          `target "${targetId}" step "${step.id}": npm subcommand "${subcommand ?? ""}" is not allowed in catalog contracts (allowed: ${ALLOWED_CATALOG_NPM_SUBCOMMANDS.join(", ")}).`,
        );
      }
      if (subcommand === "exec") {
        const hasExplicitTarget = step.args.slice(1).some((arg) => !arg.startsWith("-"));
        if (!hasExplicitTarget) {
          errors.push(
            `target "${targetId}" step "${step.id}": npm exec must declare an explicit executable name in args.`,
          );
        }
      }
    }
  }
  return errors;
}

export async function loadAndValidateCatalog(
  baseDir: string,
  catalogRelPath: string = "catalog/targets.json",
): Promise<CatalogValidationOutcome> {
  let fullPath: string;
  try {
    fullPath = resolveContainedPath(baseDir, catalogRelPath);
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }

  let rawText: string;
  try {
    rawText = await fs.readFile(fullPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      errors: [
        `Could not read catalog "${catalogRelPath}": ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    return {
      ok: false,
      errors: [
        `Invalid JSON in "${catalogRelPath}": ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  const parsedCatalog = CatalogSchema.safeParse(parsedJson);
  if (!parsedCatalog.success) {
    const errors = parsedCatalog.error.issues.map((issue) => {
      const loc = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${catalogRelPath} (${loc}): ${issue.message}`;
    });
    return { ok: false, errors };
  }

  const contracts = new Map<string, QuickstartContract>();
  const errors: string[] = [];

  for (const target of parsedCatalog.data.targets) {
    const loaded = await loadContractFile(baseDir, target.contractPath);
    if (!loaded.ok) {
      for (const err of loaded.errors) {
        errors.push(`target "${target.id}" (${target.contractPath}): ${err}`);
      }
      continue;
    }
    const policyErrors = validateCatalogContractPolicy(target.id, loaded.contract);
    if (policyErrors.length > 0) {
      errors.push(...policyErrors);
      continue;
    }
    contracts.set(target.id, loaded.contract);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    catalog: parsedCatalog.data,
    contracts,
  };
}

export function extractResolvedVersion(
  packageName: string,
  steps: Array<{ id: string; stdout: string }>,
): string | null {
  const versionStep = steps.find((s) => s.id === "resolved-version");
  if (!versionStep || versionStep.stdout.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(versionStep.stdout) as {
      dependencies?: Record<string, { version?: unknown }>;
    };
    const ver = parsed?.dependencies?.[packageName]?.version;
    return typeof ver === "string" && ver.length > 0 ? ver : null;
  } catch {
    return null;
  }
}

export function sanitizePublicExcerpt(
  text: string,
  maxBytes: number = CATALOG_LIMITS.PUBLIC_EXCERPT_BYTES,
): { text: string; truncated: boolean } {
  return sanitizeSharedPublicExcerpt(text, maxBytes);
}

export function normalizeTargetResult(
  target: CatalogTarget,
  contract: QuickstartContract,
  run: QuickstartRunResult,
): PublicTargetResult {
  const resolvedVersion = extractResolvedVersion(target.package, run.steps);
  const executedById = new Map(run.steps.map((s) => [s.id, s]));

  const steps: PublicStepEvidence[] = contract.steps.map((declaredStep) => {
    const executed = executedById.get(declaredStep.id);
    if (!executed) {
      return {
        id: declaredStep.id,
        command: declaredStep.command,
        args: declaredStep.args.map(redactSecrets),
        status: "skipped",
        failureCategory: null,
        exitCode: null,
        durationMs: 0,
        assertions: [],
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }

    const stdout = sanitizePublicExcerpt(executed.stdout);
    const stderr = sanitizePublicExcerpt(executed.stderr);
    return {
      id: executed.id,
      command: executed.command,
      args: executed.args.map(redactSecrets),
      status: executed.status,
      failureCategory: executed.failureCategory,
      exitCode: executed.exitCode,
      durationMs: executed.durationMs,
      assertions: executed.assertions,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: executed.stdoutTruncated || stdout.truncated,
      stderrTruncated: executed.stderrTruncated || stderr.truncated,
    };
  });

  const status: TargetStatus =
    run.status === "passed"
      ? "passed"
      : run.failureCategory === "environment_failed" || run.failureCategory === "internal_error"
        ? "infra_error"
        : "failed";

  return {
    id: target.id,
    name: target.name,
    package: target.package,
    resolvedVersion,
    scope: target.scope,
    status,
    checkedAt: run.startedAt,
    durationMs: run.durationMs,
    firstFailedStepId: run.firstFailedStepId,
    failureCategory: run.failureCategory,
    fingerprint: run.fingerprint,
    notRunReason: null,
    infraErrorMessage:
      status === "infra_error"
        ? sanitizePublicExcerpt(run.steps.at(-1)?.stderr || "Runner environment failed.").text
        : null,
    docsUrl: target.docsUrl,
    repositoryUrl: target.repositoryUrl,
    contractPath: target.contractPath,
    steps,
  };
}

export function buildInfraErrorResult(
  target: CatalogTarget,
  error: unknown,
): PublicTargetResult {
  const message = sanitizePublicExcerpt(
    error instanceof Error ? error.message : String(error),
    512,
  ).text;
  return {
    id: target.id,
    name: target.name,
    package: target.package,
    resolvedVersion: null,
    scope: target.scope,
    status: "infra_error",
    checkedAt: new Date().toISOString(),
    durationMs: 0,
    firstFailedStepId: null,
    failureCategory: "internal_error",
    fingerprint: null,
    notRunReason: null,
    infraErrorMessage: message,
    docsUrl: target.docsUrl,
    repositoryUrl: target.repositoryUrl,
    contractPath: target.contractPath,
    steps: [],
  };
}

export function buildNotRunResult(target: CatalogTarget, reason: string): PublicTargetResult {
  return {
    id: target.id,
    name: target.name,
    package: target.package,
    resolvedVersion: null,
    scope: target.scope,
    status: "not_run",
    checkedAt: new Date().toISOString(),
    durationMs: 0,
    firstFailedStepId: null,
    failureCategory: null,
    fingerprint: null,
    notRunReason: reason,
    infraErrorMessage: null,
    docsUrl: target.docsUrl,
    repositoryUrl: target.repositoryUrl,
    contractPath: target.contractPath,
    steps: [],
  };
}

export function summarizeResults(targets: PublicTargetResult[]): StatusDocument["summary"] {
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

export type RunCatalogOptions = {
  baseDir: string;
  catalogPath?: string;
  sourceCommit?: string | null;
  concurrency?: number;
  maxCatalogTimeoutMs?: number;
  targetIds?: string[];
  executor?: (
    contract: QuickstartContract,
    remainingMs: number,
  ) => Promise<QuickstartRunResult>;
};

export async function runCatalog(options: RunCatalogOptions): Promise<StatusDocument> {
  const validation = await loadAndValidateCatalog(
    options.baseDir,
    options.catalogPath ?? "catalog/targets.json",
  );
  if (!validation.ok) {
    throw new Error(`Catalog validation failed:\n${validation.errors.join("\n")}`);
  }

  const validatedContracts = validation.contracts;
  if (options.targetIds?.length) {
    const knownIds = new Set(validation.catalog.targets.map((t) => t.id));
    const unknownIds = options.targetIds.filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) {
      throw new Error(`Unknown catalog target id(s): ${unknownIds.join(", ")}`);
    }
  }
  const allTargets = options.targetIds?.length
    ? validation.catalog.targets.filter((t) => options.targetIds!.includes(t.id))
    : validation.catalog.targets;

  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? CATALOG_LIMITS.MAX_CONCURRENCY, CATALOG_LIMITS.MAX_CONCURRENCY),
  );
  const maxCatalogTimeoutMs =
    options.maxCatalogTimeoutMs ?? CATALOG_LIMITS.MAX_CATALOG_TIMEOUT_MS;
  const executor =
    options.executor ??
    ((contract, remainingMs) =>
      runQuickstartContract(contract, {
        maxRunTimeoutMs: Math.min(LIMITS.MAX_RUN_TIMEOUT_MS, remainingMs),
      }));
  const startedMs = Date.now();

  const results: PublicTargetResult[] = new Array(allTargets.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= allTargets.length) {
        return;
      }

      const target = allTargets[idx];
      const contract = validatedContracts.get(target.id);
      if (!contract) {
        results[idx] = buildInfraErrorResult(target, "Validated contract missing from map.");
        continue;
      }

      const remainingMs = maxCatalogTimeoutMs - (Date.now() - startedMs);
      if (remainingMs <= 0) {
        results[idx] = buildNotRunResult(target, "Catalog time budget exceeded.");
        continue;
      }

      try {
        const runResult = await executor(contract, remainingMs);
        results[idx] = normalizeTargetResult(target, contract, runResult);
      } catch (err) {
        results[idx] = buildInfraErrorResult(target, err);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, allTargets.length) }, () => worker()));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceCommit: options.sourceCommit ?? null,
    summary: summarizeResults(results),
    targets: results,
  };
}

export type RunPlatformCatalogOptions = RunCatalogOptions & {
  platform: PlatformId;
  hostPlatform?: NodeJS.Platform;
  environment?: PlatformEnvironment;
};

export async function runPlatformCatalog(
  options: RunPlatformCatalogOptions,
): Promise<PlatformRunDocument> {
  const environment =
    options.environment ??
    (await collectPlatformEnvironment(options.platform, {
      hostPlatform: options.hostPlatform,
    }));

  const legacyResult = await runCatalog(options);
  const targets = legacyResult.targets.map((t) => toPlatformPartialTarget(t.id, t));

  return PlatformRunDocumentSchema.parse({
    schemaVersion: 2,
    kind: "platform-run",
    platform: options.platform,
    generatedAt: legacyResult.generatedAt,
    sourceCommit: legacyResult.sourceCommit,
    environment,
    summary: summarizePlatformRun(targets),
    targets,
  });
}

const SAFE_BADGE_FILENAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,80}\.json$/;
const MAX_SITE_STATUS_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_SITE_HISTORY_BYTES = 512 * 1024; // 512 KiB
const MAX_SITE_BADGE_BYTES = 16 * 1024; // 16 KiB

async function readBoundedTextFile(filePath: string, maxBytes: number, label: string): Promise<string> {
  const lstat = await fs.lstat(filePath);
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    throw new Error(`${label} must be a regular file (symlinks are not allowed).`);
  }
  if (lstat.size > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes}-byte size limit (${lstat.size} bytes).`);
  }
  const text = await fs.readFile(filePath, "utf8");
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes}-byte size limit.`);
  }
  return text;
}

export async function buildStatusSite(options: {
  siteSrcDir: string;
  statusJsonPath: string;
  historyJsonPath?: string;
  badgesDir?: string;
  outDir: string;
}): Promise<void> {
  const resolvedOutDir = path.resolve(options.outDir);
  if (resolvedOutDir === path.parse(resolvedOutDir).root) {
    throw new Error(`Refusing to write status site to filesystem root: "${resolvedOutDir}"`);
  }

  const statusText = await readBoundedTextFile(
    options.statusJsonPath,
    MAX_SITE_STATUS_BYTES,
    "status.json",
  );
  let parsedStatusJson: unknown;
  try {
    parsedStatusJson = JSON.parse(statusText);
  } catch (err) {
    throw new Error(
      `Invalid JSON in status.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsedStatus = AggregateStatusDocumentSchema.safeParse(parsedStatusJson);
  if (!parsedStatus.success) {
    throw new Error(
      `Invalid status.json schema (v2 required): ${parsedStatus.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  let validatedHistoryText: string | null = null;
  if (options.historyJsonPath) {
    const historyText = await readBoundedTextFile(
      options.historyJsonPath,
      MAX_SITE_HISTORY_BYTES,
      "history.json",
    );
    let parsedHistoryJson: unknown;
    try {
      parsedHistoryJson = JSON.parse(historyText);
    } catch (err) {
      throw new Error(
        `Invalid JSON in history.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsedHistory = HistoryDocumentSchema.safeParse(parsedHistoryJson);
    if (!parsedHistory.success) {
      throw new Error(
        `Invalid history.json schema: ${parsedHistory.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    validatedHistoryText = `${JSON.stringify(parsedHistory.data, null, 2)}\n`;
  }

  await fs.rm(resolvedOutDir, { recursive: true, force: true });
  await fs.mkdir(resolvedOutDir, { recursive: true });

  const entries = await fs.readdir(options.siteSrcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    await fs.copyFile(
      path.join(options.siteSrcDir, entry.name),
      path.join(resolvedOutDir, entry.name),
    );
  }

  await fs.writeFile(
    path.join(resolvedOutDir, "status.json"),
    `${JSON.stringify(parsedStatus.data, null, 2)}\n`,
    "utf8",
  );

  if (validatedHistoryText !== null) {
    await fs.writeFile(path.join(resolvedOutDir, "history.json"), validatedHistoryText, "utf8");
  }

  const outBadgesDir = path.join(resolvedOutDir, "badges");
  if (options.badgesDir) {
    const badgeEntries = await fs.readdir(options.badgesDir, { withFileTypes: true });
    await fs.mkdir(outBadgesDir, { recursive: true });
    for (const entry of badgeEntries) {
      if (!entry.isFile()) continue;
      if (!SAFE_BADGE_FILENAME_REGEX.test(entry.name)) {
        throw new Error(`Unsafe badge filename in badgesDir: "${entry.name}"`);
      }
      const rawBadge = await readBoundedTextFile(
        path.join(options.badgesDir, entry.name),
        MAX_SITE_BADGE_BYTES,
        `badge "${entry.name}"`,
      );
      const validatedBadge = ShieldsEndpointSchema.parse(JSON.parse(rawBadge));
      await fs.writeFile(
        path.join(outBadgesDir, entry.name),
        `${JSON.stringify(validatedBadge, null, 2)}\n`,
        "utf8",
      );
    }
  } else {
    const badges = generateBadges(parsedStatus.data);
    await writeBadges(outBadgesDir, badges);
  }

  await fs.writeFile(path.join(resolvedOutDir, ".nojekyll"), "", "utf8");
}
