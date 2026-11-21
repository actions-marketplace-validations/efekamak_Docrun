import * as z from "zod/v4";
import { CATALOG_LIMITS } from "./catalog-limits.js";
import {
  AggregateTargetStatusSchema,
  CommitShaSchema,
  IsoDateTimeSchema,
  PlatformTargetStatusSchema,
  type AggregateStatusDocument,
} from "./status-v2.js";

export const DEFAULT_HISTORY_URL = "https://efekamak.github.io/Docrun/history.json";
export const ALLOWED_HISTORY_HOST = "efekamak.github.io";
export const ALLOWED_HISTORY_PATH = "/Docrun/history.json";
export const MAX_HISTORY_DAYS = 7;
export const MAX_HISTORY_FETCH_BYTES = 512 * 1024; // 512 KiB
export const HISTORY_FETCH_TIMEOUT_MS = 5_000;

const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UTC_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidUtcDate(candidate: string): boolean {
  if (!UTC_DATE_REGEX.test(candidate)) {
    return false;
  }
  const [y, m, d] = candidate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export const UtcDateSchema = z.string().refine(isValidUtcDate, {
  message: "Date must be a valid YYYY-MM-DD UTC date.",
});

export const HistoryPlatformEntrySchema = z
  .object({
    status: PlatformTargetStatusSchema,
    resolvedVersion: z.string().min(1).max(64).nullable(),
  })
  .strict();

export const HistoryTargetSchema = z
  .object({
    id: z.string().regex(SLUG_REGEX),
    aggregateStatus: AggregateTargetStatusSchema,
    platforms: z
      .object({
        ubuntu: HistoryPlatformEntrySchema,
        windows: HistoryPlatformEntrySchema,
      })
      .strict(),
  })
  .strict();

export const HistoryDaySchema = z
  .object({
    date: UtcDateSchema,
    generatedAt: IsoDateTimeSchema,
    sourceCommit: CommitShaSchema.nullable(),
    overallStatus: AggregateTargetStatusSchema,
    targets: z.array(HistoryTargetSchema).min(1).max(CATALOG_LIMITS.MAX_TARGETS),
  })
  .strict()
  .superRefine((day, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < day.targets.length; i += 1) {
      const id = day.targets[i].id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", i, "id"],
          message: `Duplicate target id in history day ${day.date}: "${id}".`,
        });
      }
      seen.add(id);
    }
  });

export type HistoryDay = z.infer<typeof HistoryDaySchema>;

export const HistoryDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: IsoDateTimeSchema,
    days: z.array(HistoryDaySchema).max(MAX_HISTORY_DAYS),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < doc.days.length; i += 1) {
      const date = doc.days[i].date;
      if (seen.has(date)) {
        ctx.addIssue({
          code: "custom",
          path: ["days", i, "date"],
          message: `Duplicate date in history: "${date}".`,
        });
      }
      seen.add(date);
    }
  });

export type HistoryDocument = z.infer<typeof HistoryDocumentSchema>;

export function validateHistoryFetchUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid history URL: "${rawUrl}"`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`History URL must use https:// (got "${parsed.protocol}")`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("History URL must not contain credentials.");
  }
  if (parsed.hostname.toLowerCase() !== ALLOWED_HISTORY_HOST) {
    throw new Error(
      `History URL host must be "${ALLOWED_HISTORY_HOST}" (got "${parsed.hostname}").`,
    );
  }
  if (parsed.port !== "") {
    throw new Error("History URL must not specify a custom port.");
  }
  if (parsed.pathname !== ALLOWED_HISTORY_PATH) {
    throw new Error(
      `History URL path must be "${ALLOWED_HISTORY_PATH}" (got "${parsed.pathname}").`,
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("History URL must not contain query parameters or fragments.");
  }

  return parsed;
}

export type FetchPreviousHistoryResult =
  | {
      ok: true;
      history: HistoryDocument;
    }
  | {
      ok: false;
      reason: string;
    };

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`History response Content-Length (${declaredLength}) exceeds ${maxBytes} bytes.`);
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`History response exceeds ${maxBytes} bytes.`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`History response stream exceeded ${maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export async function fetchPreviousHistory(
  urlString: string = DEFAULT_HISTORY_URL,
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
  },
): Promise<FetchPreviousHistoryResult> {
  let validatedUrl: URL;
  try {
    validatedUrl = validateHistoryFetchUrl(urlString);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? HISTORY_FETCH_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? MAX_HISTORY_FETCH_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(validatedUrl.href, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        reason: `History fetch received disallowed redirect status ${response.status}.`,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: `History fetch returned HTTP ${response.status}.`,
      };
    }

    const rawText = await readBoundedResponseText(response, maxBytes);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      return {
        ok: false,
        reason: "Previous history.json contained invalid JSON.",
      };
    }

    const validated = HistoryDocumentSchema.safeParse(parsedJson);
    if (!validated.success) {
      return {
        ok: false,
        reason: `Previous history.json failed schema validation: ${validated.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
          .join("; ")}`,
      };
    }

    return {
      ok: true,
      history: validated.data,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        reason: `History fetch timed out after ${timeoutMs}ms.`,
      };
    }
    return {
      ok: false,
      reason: `History fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildHistoryDaySnapshot(status: AggregateStatusDocument): HistoryDay {
  const utcDate = new Date(status.generatedAt).toISOString().slice(0, 10);
  const snapshot: HistoryDay = {
    date: utcDate,
    generatedAt: status.generatedAt,
    sourceCommit: status.sourceCommit,
    overallStatus: status.overallStatus,
    targets: status.targets.map((target) => ({
      id: target.id,
      aggregateStatus: target.aggregateStatus,
      platforms: {
        ubuntu: {
          status: target.results.ubuntu.status,
          resolvedVersion: target.results.ubuntu.resolvedVersion,
        },
        windows: {
          status: target.results.windows.status,
          resolvedVersion: target.results.windows.resolvedVersion,
        },
      },
    })),
  };

  return HistoryDaySchema.parse(snapshot);
}

export function mergeHistory(
  previous: HistoryDocument | null,
  currentStatus: AggregateStatusDocument,
): HistoryDocument {
  const todaySnapshot = buildHistoryDaySnapshot(currentStatus);
  const priorDays = previous ? previous.days.filter((day) => day.date !== todaySnapshot.date) : [];
  const combined = [...priorDays, todaySnapshot]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-MAX_HISTORY_DAYS);

  return HistoryDocumentSchema.parse({
    schemaVersion: 1,
    updatedAt: currentStatus.generatedAt,
    days: combined,
  });
}
