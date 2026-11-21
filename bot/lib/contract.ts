import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as z from "zod/v4";

export const LIMITS = {
  DEFAULT_STEP_TIMEOUT_MS: 120_000,
  MAX_RUN_TIMEOUT_MS: 480_000,
  MAX_STREAM_BYTES: 65_536,
  MAX_STEPS: 20,
  MAX_FILES: 20,
  MAX_TOTAL_FILE_BYTES: 262_144,
} as const;

export const ALLOWED_COMMANDS = ["node", "npm"] as const;
export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

export const FAILURE_CATEGORIES = [
  "contract_invalid",
  "docs_drift",
  "install_failed",
  "runtime_failed",
  "assertion_failed",
  "timed_out",
  "environment_failed",
  "internal_error",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_DRIVE_REGEX = /^[A-Za-z]:/;
const WINDOWS_RESERVED_NAME_REGEX = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export function isSafeRelativePath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 240 || candidate.includes("\0")) {
    return false;
  }
  if (candidate.startsWith("/") || candidate.startsWith("\\")) {
    return false;
  }
  if (WINDOWS_DRIVE_REGEX.test(candidate)) {
    return false;
  }
  const normalized = candidate.replace(/\\/g, "/");
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return false;
    }
    if (segment.endsWith(" ") || segment.endsWith(".")) {
      return false;
    }
    if (WINDOWS_RESERVED_NAME_REGEX.test(segment)) {
      return false;
    }
  }
  return true;
}

export function resolveContainedPath(baseDir: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`Unsafe relative path: "${relativePath}"`);
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativePath);
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
    throw new Error(`Path escapes base directory: "${relativePath}"`);
  }
  return resolvedTarget;
}

const SafeRelativePathSchema = z
  .string()
  .min(1)
  .refine(isSafeRelativePath, {
    message: "Path must be a clean relative path inside the workspace (no .., absolute paths, drive prefixes, or null bytes).",
  });

const StepExpectSchema = z
  .object({
    exitCode: z.number().int().default(0),
    stdoutIncludes: z.array(z.string().min(1)).optional(),
    stderrIncludes: z.array(z.string().min(1)).optional(),
    filesExist: z.array(SafeRelativePathSchema).optional(),
  })
  .strict();

const StepSchema = z
  .object({
    id: z.string().regex(SLUG_REGEX, "Step id must be a lowercase slug (a-z, 0-9, -, _)."),
    command: z.enum(ALLOWED_COMMANDS),
    args: z.array(
      z.string().refine((arg) => !arg.includes("\0"), {
        message: "Command arguments must not contain null bytes.",
      }),
    ),
    timeoutMs: z.number().int().positive().max(LIMITS.MAX_RUN_TIMEOUT_MS),
    expect: StepExpectSchema,
  })
  .strict();

export const QuickstartContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().regex(SLUG_REGEX, "Contract name must be a lowercase slug (a-z, 0-9, -, _)."),
    readmePath: SafeRelativePathSchema.optional(),
    files: z.record(z.string(), z.string()).default({}),
    steps: z.array(StepSchema).min(1).max(LIMITS.MAX_STEPS),
  })
  .strict()
  .superRefine((contract, ctx) => {
    const fileEntries = Object.entries(contract.files);
    if (fileEntries.length > LIMITS.MAX_FILES) {
      ctx.addIssue({
        code: "custom",
        path: ["files"],
        message: `At most ${LIMITS.MAX_FILES} fixture files are allowed (got ${fileEntries.length}).`,
      });
    }

    let totalBytes = 0;
    for (const [filePath, content] of fileEntries) {
      if (!isSafeRelativePath(filePath)) {
        ctx.addIssue({
          code: "custom",
          path: ["files", filePath],
          message: `Unsafe fixture file path: "${filePath}".`,
        });
      }
      totalBytes += Buffer.byteLength(content, "utf8");
    }

    if (totalBytes > LIMITS.MAX_TOTAL_FILE_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["files"],
        message: `Total fixture content exceeds ${LIMITS.MAX_TOTAL_FILE_BYTES} bytes (got ${totalBytes}).`,
      });
    }

    const seenStepIds = new Set<string>();
    for (let i = 0; i < contract.steps.length; i += 1) {
      const step = contract.steps[i];
      if (seenStepIds.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "id"],
          message: `Duplicate step id: "${step.id}".`,
        });
      }
      seenStepIds.add(step.id);
    }
  });

export type QuickstartContract = z.infer<typeof QuickstartContractSchema>;
export type QuickstartStep = QuickstartContract["steps"][number];

export type ContractValidationResult =
  | { ok: true; contract: QuickstartContract }
  | { ok: false; errors: string[] };

export function validateContract(raw: unknown): ContractValidationResult {
  const parsed = QuickstartContractSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, contract: parsed.data };
  }
  const errors = parsed.error.issues.map((issue) => {
    const loc = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${loc}: ${issue.message}`;
  });
  return { ok: false, errors };
}

export async function loadContractFile(
  baseDir: string,
  contractPath: string,
): Promise<ContractValidationResult> {
  let fullPath: string;
  try {
    fullPath = resolveContainedPath(baseDir, contractPath);
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }

  let text: string;
  try {
    text = await fs.readFile(fullPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      errors: [
        `Could not read contract at "${contractPath}": ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [`Invalid JSON in "${contractPath}": ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  return validateContract(json);
}

export function renderStepCommand(step: Pick<QuickstartStep, "command" | "args">): string {
  const parts = [step.command, ...step.args.map((arg) => (/[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg))];
  return parts.join(" ");
}

export function renderContractCommands(contract: QuickstartContract): string[] {
  return contract.steps.map(renderStepCommand);
}

export type ReadmeDriftCheck =
  | { ok: true; expectedCommands: string[]; observedCommands: string[] }
  | { ok: false; reason: string; expectedCommands: string[]; observedCommands: string[] };

const START_MARKER = "<!-- docrun:start -->";
const END_MARKER = "<!-- docrun:end -->";

export function checkReadmeDrift(readmeContent: string, contract: QuickstartContract): ReadmeDriftCheck {
  const expectedCommands = renderContractCommands(contract);
  const startIdx = readmeContent.indexOf(START_MARKER);
  const endIdx = readmeContent.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return {
      ok: false,
      reason: `README is missing a valid ${START_MARKER} ... ${END_MARKER} block.`,
      expectedCommands,
      observedCommands: [],
    };
  }

  const block = readmeContent.slice(startIdx + START_MARKER.length, endIdx);
  const fenceMatch = block.match(/```(?:bash|sh|shell)?\r?\n([\s\S]*?)```/);
  if (!fenceMatch) {
    return {
      ok: false,
      reason: "Marked quickstart block does not contain a fenced command block.",
      expectedCommands,
      observedCommands: [],
    };
  }

  const observedCommands = fenceMatch[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const matches =
    observedCommands.length === expectedCommands.length &&
    observedCommands.every((cmd, idx) => cmd === expectedCommands[idx]);

  if (!matches) {
    return {
      ok: false,
      reason: "README quickstart commands differ from docrun.json.",
      expectedCommands,
      observedCommands,
    };
  }

  return { ok: true, expectedCommands, observedCommands };
}
