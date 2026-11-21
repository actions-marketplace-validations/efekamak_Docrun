import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_HISTORY_HOST,
  ALLOWED_HISTORY_PATH,
  DEFAULT_HISTORY_URL,
  HistoryDocumentSchema,
  MAX_HISTORY_FETCH_BYTES,
  fetchPreviousHistory,
  mergeHistory,
  validateHistoryFetchUrl,
  type HistoryDocument,
} from "../scripts/history.js";
import {
  AggregateStatusDocumentSchema,
  type AggregateStatusDocument,
  type PlatformEnvironment,
  type PlatformTargetResult,
} from "../scripts/status-v2.js";

const EXACT_HISTORY_URL = "https://efekamak.github.io/Docrun/history.json";

function environmentFor(platform: "ubuntu" | "windows"): PlatformEnvironment {
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

function platformResult(resolvedVersion: string, checkedAt: string): PlatformTargetResult {
  return {
    status: "passed",
    resolvedVersion,
    checkedAt,
    durationMs: 25,
    firstFailedStepId: null,
    failureCategory: null,
    fingerprint: null,
    notRunReason: null,
    infraErrorMessage: null,
    steps: [
      {
        id: "run-step",
        command: "node",
        args: ["index.mjs"],
        status: "passed",
        failureCategory: null,
        exitCode: 0,
        durationMs: 25,
        assertions: [{ kind: "exitCode", expected: "0", observed: "0", passed: true }],
        stdout: "SECRET_STDOUT_SHOULD_NOT_LEAK",
        stderr: "SECRET_STDERR_SHOULD_NOT_LEAK",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    ],
  };
}

function statusDocument(options: {
  generatedAt: string;
  sourceCommit?: string | null;
  version?: string;
}): AggregateStatusDocument {
  const version = options.version ?? "1.2.3";
  const sourceCommit = options.sourceCommit === undefined ? "abc1234" : options.sourceCommit;
  return AggregateStatusDocumentSchema.parse({
    schemaVersion: 2,
    kind: "aggregate-status",
    generatedAt: options.generatedAt,
    sourceCommit,
    requiredPlatforms: ["ubuntu", "windows"],
    overallStatus: "passed",
    summary: {
      targets: 1,
      passed: 1,
      failed: 0,
      infraErrors: 0,
      incomplete: 0,
      platformChecks: 2,
      platformPassed: 2,
      platformFailed: 0,
      platformInfraErrors: 0,
      platformNotRun: 0,
    },
    platforms: {
      ubuntu: {
        runStatus: "complete",
        generatedAt: options.generatedAt,
        environment: environmentFor("ubuntu"),
        note: null,
      },
      windows: {
        runStatus: "complete",
        generatedAt: options.generatedAt,
        environment: environmentFor("windows"),
        note: null,
      },
    },
    targets: [
      {
        id: "alpha",
        name: "Alpha",
        package: "alpha",
        scope: "install + import",
        docsUrl: "https://example.com/alpha/docs",
        repositoryUrl: "https://github.com/example/alpha",
        contractPath: "catalog/contracts/alpha/docrun.json",
        aggregateStatus: "passed",
        versionDrift: false,
        results: {
          ubuntu: platformResult(version, options.generatedAt),
          windows: platformResult(version, options.generatedAt),
        },
      },
    ],
  });
}

function responseFetch(response: Response): typeof fetch {
  return (async () => response) as typeof fetch;
}

describe("validateHistoryFetchUrl", () => {
  it("accepts the exact published history URL", () => {
    assert.equal(DEFAULT_HISTORY_URL, EXACT_HISTORY_URL);
    const url = validateHistoryFetchUrl(EXACT_HISTORY_URL);
    assert.equal(url.href, EXACT_HISTORY_URL);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, ALLOWED_HISTORY_HOST);
    assert.equal(url.pathname, ALLOWED_HISTORY_PATH);
    assert.equal(url.port, "");
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
  });

  it("rejects http, other hosts, wrong paths, query, hash, ports, and credentials", () => {
    const cases: Array<[string, RegExp]> = [
      ["http://efekamak.github.io/Docrun/history.json", /https:\/\//],
      ["https://example.com/Docrun/history.json", /host must be/],
      ["https://efekamak.github.io.evil.com/Docrun/history.json", /host must be/],
      ["https://efekamak.github.io/docrun/history.json", /path must be/],
      ["https://efekamak.github.io/Docrun/history.json/", /path must be/],
      ["https://efekamak.github.io/history.json", /path must be/],
      ["https://efekamak.github.io/Docrun/history.json?cache=1", /query parameters or fragments/],
      ["https://efekamak.github.io/Docrun/history.json#top", /query parameters or fragments/],
      ["https://efekamak.github.io:8443/Docrun/history.json", /custom port/],
      ["https://user:secret@efekamak.github.io/Docrun/history.json", /credentials/],
    ];
    for (const [raw, pattern] of cases) {
      assert.throws(() => validateHistoryFetchUrl(raw), pattern, raw);
    }
  });
});

describe("fetchPreviousHistory", () => {
  it("returns the parsed history for a valid response", async () => {
    const history = mergeHistory(
      null,
      statusDocument({ generatedAt: "2026-11-21T12:00:00.000Z" }),
    );
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), redirect: init?.redirect });
      return new Response(JSON.stringify(history), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await fetchPreviousHistory(DEFAULT_HISTORY_URL, { fetchImpl });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.history, history);
    assert.deepEqual(calls, [{ url: EXACT_HISTORY_URL, redirect: "error" }]);
  });

  it("returns ok false for HTTP 404", async () => {
    const result = await fetchPreviousHistory(DEFAULT_HISTORY_URL, {
      fetchImpl: responseFetch(new Response("missing", { status: 404 })),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /HTTP 404/);
  });

  it("returns ok false for a 302 redirect response", async () => {
    const result = await fetchPreviousHistory(DEFAULT_HISTORY_URL, {
      fetchImpl: responseFetch(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/history.json" },
        }),
      ),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /disallowed redirect status 302/);
  });

  it("returns ok false when fetch rejects because redirect mode is error", async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.redirect === "error") {
        throw new Error("redirect mode is set to error: https://evil.example/history.json");
      }
      return new Response(null, { status: 302 });
    }) as typeof fetch;

    const result = await fetchPreviousHistory(DEFAULT_HISTORY_URL, { fetchImpl });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /History fetch failed/);
    assert.match(result.reason, /redirect mode is set to error/);
  });

  it("returns ok false for invalid JSON", async () => {
    const result = await fetchPreviousHistory(DEFAULT_HISTORY_URL, {
      fetchImpl: responseFetch(new Response("{", { status: 200 })),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /invalid JSON/);
  });

  it("returns ok false for an invalid schema, an unknown field, or a stdout field", async () => {
    const history = mergeHistory(
      null,
      statusDocument({ generatedAt: "2026-11-21T12:00:00.000Z" }),
    );
    const validJson = JSON.parse(JSON.stringify(history)) as {
      days: Array<{ targets: Array<Record<string, unknown>> }>;
    };

    const invalidSchema = await fetchPreviousHistory(DEFAULT_HISTORY_URL, {
      fetchImpl: responseFetch(
        new Response(
          JSON.stringify({ schemaVersion: 2, updatedAt: history.updatedAt, days: [] }),
          { status: 200 },
        ),
      ),
    });
    assert.equal(invalidSchema.ok, false);
    if (invalidSchema.ok) return;
    assert.match(invalidSchema.reason, /failed schema validation/);

    const extraField = await fetchPreviousHistory(DEFAULT_HISTORY_URL, {
      fetchImpl: responseFetch(
        new Response(JSON.stringify({ ...validJson, note: "extra" }), { status: 200 }),
      ),
    });
    assert.equal(extraField.ok, false);
    if (extraField.ok) return;
    assert.match(extraField.reason, /failed schema validation/);

    const withStdout = structuredClone(validJson);
    withStdout.days[0].targets[0].stdout = "leaked command output";
    const stdoutField = await fetchPreviousHistory(DEFAULT_HISTORY_URL, {
      fetchImpl: responseFetch(new Response(JSON.stringify(withStdout), { status: 200 })),
    });
    assert.equal(stdoutField.ok, false);
    if (stdoutField.ok) return;
    assert.match(stdoutField.reason, /failed schema validation/);
    assert.match(stdoutField.reason, /stdout/);
  });

  it("returns ok false when the request times out via AbortController", async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (!signal) {
          reject(new Error("expected an abort signal"));
          return;
        }
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch;

    const result = await fetchPreviousHistory(DEFAULT_HISTORY_URL, {
      fetchImpl,
      timeoutMs: 30,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /timed out after 30ms/);
  });

  it("returns ok false when Content-Length is over 512KB", async () => {
    assert.equal(MAX_HISTORY_FETCH_BYTES, 512 * 1024);
    const declared = MAX_HISTORY_FETCH_BYTES + 1;
    const response = {
      status: 200,
      ok: true,
      headers: new Headers({ "content-length": String(declared) }),
      body: null,
      text: async () => {
        throw new Error("body should not be read when Content-Length exceeds the cap");
      },
    } as unknown as Response;

    const result = await fetchPreviousHistory(DEFAULT_HISTORY_URL, {
      fetchImpl: responseFetch(response),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(
      result.reason,
      new RegExp(`Content-Length \\(${declared}\\) exceeds ${MAX_HISTORY_FETCH_BYTES} bytes`),
    );
  });

  it("returns ok false when streamed chunks exceed 512KB", async () => {
    assert.equal(MAX_HISTORY_FETCH_BYTES, 512 * 1024);
    const chunk = new Uint8Array(256 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const result = await fetchPreviousHistory(DEFAULT_HISTORY_URL, {
      fetchImpl: responseFetch(new Response(stream, { status: 200 })),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /stream exceeded 524288 bytes/);
  });
});

describe("mergeHistory", () => {
  it("creates a one-day history from the first run using the UTC date", () => {
    const generatedAt = "2026-11-21T22:30:00.000Z";
    const history = mergeHistory(null, statusDocument({ generatedAt, sourceCommit: "abc1234" }));
    assert.equal(history.schemaVersion, 1);
    assert.equal(history.updatedAt, generatedAt);
    assert.equal(history.days.length, 1);
    assert.equal(history.days[0].date, "2026-11-21");
    assert.equal(history.days[0].generatedAt, generatedAt);
    assert.equal(history.days[0].sourceCommit, "abc1234");
    assert.equal(history.days[0].overallStatus, "passed");
    assert.equal(history.days[0].targets[0].id, "alpha");
    assert.equal(history.days[0].targets[0].platforms.ubuntu.resolvedVersion, "1.2.3");
  });

  it("appends a second UTC day in chronological order", () => {
    const first = statusDocument({
      generatedAt: "2026-11-21T22:30:00.000Z",
      sourceCommit: "abc1234",
    });
    const second = statusDocument({
      generatedAt: "2026-11-22T00:15:00.000Z",
      sourceCommit: "def5678",
    });
    const history = mergeHistory(mergeHistory(null, first), second);
    assert.deepEqual(
      history.days.map((day) => day.date),
      ["2026-11-21", "2026-11-22"],
    );
    assert.equal(history.days[1].sourceCommit, "def5678");
    assert.equal(history.updatedAt, second.generatedAt);

    const reversed = mergeHistory(mergeHistory(null, second), first);
    assert.deepEqual(
      reversed.days.map((day) => day.date),
      ["2026-11-21", "2026-11-22"],
    );
    assert.equal(reversed.days[0].sourceCommit, "abc1234");
  });

  it("replaces the same UTC day idempotently without duplicating dates", () => {
    const morning = statusDocument({
      generatedAt: "2026-11-21T08:00:00.000Z",
      sourceCommit: "abc1234",
      version: "1.0.0",
    });
    const evening = statusDocument({
      generatedAt: "2026-11-21T18:00:00.000Z",
      sourceCommit: "def5678",
      version: "1.1.0",
    });
    const once = mergeHistory(mergeHistory(null, morning), evening);
    assert.equal(once.days.length, 1);
    assert.equal(once.days[0].date, "2026-11-21");
    assert.equal(once.days[0].generatedAt, "2026-11-21T18:00:00.000Z");
    assert.equal(once.days[0].sourceCommit, "def5678");
    assert.equal(once.days[0].targets[0].platforms.ubuntu.resolvedVersion, "1.1.0");
    assert.equal(once.days[0].targets[0].platforms.windows.resolvedVersion, "1.1.0");
    assert.equal(once.days[0].targets[0].platforms.ubuntu.status, "passed");

    const twice = mergeHistory(once, evening);
    assert.deepEqual(twice, once);
    assert.equal(new Set(twice.days.map((day) => day.date)).size, twice.days.length);
    assert.equal(HistoryDocumentSchema.safeParse(twice).success, true);
  });

  it("prunes the oldest day when an 8th UTC day is added", () => {
    let history: HistoryDocument | null = null;
    const dates: string[] = [];
    for (let day = 1; day <= 8; day += 1) {
      const date = `2026-11-${String(day).padStart(2, "0")}`;
      dates.push(date);
      history = mergeHistory(
        history,
        statusDocument({
          generatedAt: `${date}T12:00:00.000Z`,
          sourceCommit: `abc123${day}`,
          version: `1.0.${day}`,
        }),
      );
    }

    assert.ok(history);
    assert.equal(history.days.length, 7);
    assert.deepEqual(
      history.days.map((day) => day.date),
      dates.slice(1),
    );
    assert.equal(history.days[0].date, "2026-11-02");
    assert.equal(history.days[0].sourceCommit, "abc1232");
    assert.equal(history.days.at(-1)?.date, "2026-11-08");
    assert.equal(history.days.at(-1)?.sourceCommit, "abc1238");
    assert.equal(
      history.days.some((day) => day.date === "2026-11-01"),
      false,
    );
  });

  it("does not mutate previous history or the current status and omits stdout and stderr", () => {
    const previous = mergeHistory(
      null,
      statusDocument({ generatedAt: "2026-11-20T12:00:00.000Z", version: "1.0.0" }),
    );
    const current = statusDocument({ generatedAt: "2026-11-21T12:00:00.000Z", version: "2.0.0" });
    const previousSnapshot = structuredClone(previous);
    const currentSnapshot = structuredClone(current);

    const history = mergeHistory(previous, current);

    assert.deepEqual(previous, previousSnapshot);
    assert.deepEqual(current, currentSnapshot);
    assert.equal(current.overallStatus, "passed");
    assert.equal(current.targets[0].results.ubuntu.resolvedVersion, "2.0.0");
    assert.equal(current.targets[0].results.ubuntu.steps[0].stdout, "SECRET_STDOUT_SHOULD_NOT_LEAK");
    assert.equal(current.targets[0].results.windows.steps[0].stderr, "SECRET_STDERR_SHOULD_NOT_LEAK");

    const serialized = JSON.stringify(history);
    assert.equal(serialized.includes("stdout"), false);
    assert.equal(serialized.includes("stderr"), false);
    assert.equal(serialized.includes("SECRET_STDOUT_SHOULD_NOT_LEAK"), false);
    assert.equal(serialized.includes("SECRET_STDERR_SHOULD_NOT_LEAK"), false);

    const dayTarget = history.days[1].targets[0];
    assert.deepEqual(Object.keys(dayTarget).sort(), ["aggregateStatus", "id", "platforms"]);
    assert.deepEqual(Object.keys(dayTarget.platforms.ubuntu).sort(), ["resolvedVersion", "status"]);
    assert.deepEqual(Object.keys(dayTarget.platforms.windows).sort(), ["resolvedVersion", "status"]);
    assert.equal(dayTarget.platforms.ubuntu.resolvedVersion, "2.0.0");
    assert.equal(history.days[0].targets[0].platforms.ubuntu.resolvedVersion, "1.0.0");
  });
});
