const REPO_BASE = "https://github.com/efekamak/Docrun";
const PLATFORMS = ["ubuntu", "windows"];
const PLATFORM_LABELS = {
  ubuntu: "Ubuntu",
  windows: "Windows",
};
const VALID_AGGREGATE_STATUSES = new Set(["passed", "failed", "infra_error", "incomplete"]);
const VALID_PLATFORM_STATUSES = new Set(["passed", "failed", "infra_error", "not_run"]);
const VALID_STEP_STATUSES = new Set(["passed", "failed", "timed_out", "skipped"]);
const SAFE_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function sanitizeStatus(status, allowedSet, fallback) {
  return typeof status === "string" && allowedSet.has(status) ? status : fallback;
}

function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return "-";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatLocalTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatShortUtcDate(dateStr) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return "-";
  }
  const dt = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return dateStr;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  }).format(dt);
}

function statusLabel(status) {
  switch (status) {
    case "passed":
      return "PASS";
    case "failed":
      return "FAIL";
    case "infra_error":
      return "INFRA ERROR";
    case "incomplete":
      return "INCOMPLETE";
    case "not_run":
      return "NOT RUN";
    default:
      return "UNKNOWN";
  }
}

function compactStatusLabel(status) {
  switch (status) {
    case "passed":
      return "PASS";
    case "failed":
      return "FAIL";
    case "infra_error":
      return "INFRA";
    case "not_run":
      return "NOT RUN";
    default:
      return "UNKNOWN";
  }
}

function statusSymbol(status) {
  switch (status) {
    case "passed":
      return "✓";
    case "failed":
    case "timed_out":
      return "✕";
    case "infra_error":
      return "!";
    case "skipped":
    case "not_run":
    case "incomplete":
      return "○";
    default:
      return "·";
  }
}

function safeHttpsUrl(candidate) {
  if (typeof candidate !== "string") return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * Temporary read-only fallback for schema v1 snapshots during cache transitions.
 * Maps v1 rows to Ubuntu-only results and labels Windows as not_run so aggregate
 * status is never falsely promoted to passed.
 */
function normalizeLegacyV1ToViewModel(v1) {
  const targets = (Array.isArray(v1.targets) ? v1.targets : []).map((t) => {
    const ubuntuStatus = sanitizeStatus(t.status, VALID_PLATFORM_STATUSES, "infra_error");
    const aggregateStatus =
      ubuntuStatus === "failed"
        ? "failed"
        : ubuntuStatus === "infra_error"
          ? "infra_error"
          : "incomplete";
    return {
      id: t.id,
      name: t.name,
      package: t.package,
      scope: t.scope,
      docsUrl: t.docsUrl,
      repositoryUrl: t.repositoryUrl,
      contractPath: t.contractPath,
      aggregateStatus,
      versionDrift: false,
      results: {
        ubuntu: {
          status: ubuntuStatus,
          resolvedVersion: t.resolvedVersion ?? null,
          checkedAt: t.checkedAt ?? v1.generatedAt ?? "",
          durationMs: typeof t.durationMs === "number" ? t.durationMs : 0,
          firstFailedStepId: t.firstFailedStepId ?? null,
          failureCategory: t.failureCategory ?? null,
          fingerprint: t.fingerprint ?? null,
          notRunReason: t.notRunReason ?? null,
          infraErrorMessage: t.infraErrorMessage ?? null,
          steps: Array.isArray(t.steps) ? t.steps : [],
        },
        windows: {
          status: "not_run",
          resolvedVersion: null,
          checkedAt: v1.generatedAt ?? "",
          durationMs: 0,
          firstFailedStepId: null,
          failureCategory: null,
          fingerprint: null,
          notRunReason: "Legacy schema v1 snapshot (Ubuntu only).",
          infraErrorMessage: null,
          steps: [],
        },
      },
    };
  });

  let passed = 0;
  let failed = 0;
  let infraErrors = 0;
  let incomplete = 0;
  let platformPassed = 0;
  for (const t of targets) {
    if (t.aggregateStatus === "passed") passed += 1;
    else if (t.aggregateStatus === "failed") failed += 1;
    else if (t.aggregateStatus === "infra_error") infraErrors += 1;
    else incomplete += 1;
    if (t.results.ubuntu.status === "passed") platformPassed += 1;
  }

  return {
    legacyV1: true,
    generatedAt: v1.generatedAt ?? "",
    sourceCommit: v1.sourceCommit ?? null,
    summary: {
      targets: targets.length,
      passed,
      failed,
      infraErrors,
      incomplete,
      platformChecks: targets.length * 2,
      platformPassed,
    },
    platforms: {
      ubuntu: { runStatus: "complete", generatedAt: v1.generatedAt ?? null, environment: null, note: "Legacy v1 snapshot" },
      windows: { runStatus: "infra_error", generatedAt: null, environment: null, note: "Not included in legacy v1 snapshot" },
    },
    targets,
  };
}

function parseStatusDocument(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid status.json");
  }
  if (raw.schemaVersion === 2 && raw.kind === "aggregate-status" && Array.isArray(raw.targets)) {
    return { legacyV1: false, ...raw };
  }
  if (raw.schemaVersion === 1 && Array.isArray(raw.targets)) {
    return normalizeLegacyV1ToViewModel(raw);
  }
  throw new Error("Unsupported status.json schema");
}

function renderPlatformEnvironments(container, platforms) {
  container.replaceChildren();
  if (!platforms || typeof platforms !== "object") {
    container.hidden = true;
    return;
  }

  for (const platformId of PLATFORMS) {
    const overview = platforms[platformId];
    const cell = el(
      "div",
      overview?.runStatus === "infra_error" ? "env-cell is-infra" : "env-cell",
    );
    cell.appendChild(el("span", "env-platform", PLATFORM_LABELS[platformId]));

    if (overview?.runStatus === "complete" && overview.environment) {
      const env = overview.environment;
      const osLabel = env.runnerImage
        ? `${env.osName} (${env.runnerImage})`
        : env.osVersion || env.osName;
      const parts = [
        osLabel,
        env.nodeVersion ? `Node ${env.nodeVersion}` : null,
        env.npmVersion ? `npm ${env.npmVersion}` : null,
        env.arch || null,
      ].filter(Boolean);
      const detailsEl = el("span", "env-details", parts.join(" · "));
      const fullOs = [env.osVersion, env.osRelease].filter(Boolean).join(" / ");
      if (fullOs) {
        detailsEl.title = fullOs;
      }
      cell.appendChild(detailsEl);
    } else {
      const note = overview?.note || "Runner metadata unavailable.";
      cell.appendChild(el("span", "env-details", note));
    }

    container.appendChild(cell);
  }

  container.hidden = false;
}

function renderProofStrip(platformId, result) {
  const strip = el("div", "proof-strip");
  strip.setAttribute("aria-label", `${PLATFORM_LABELS[platformId]} contract steps`);

  const steps = Array.isArray(result?.steps) ? result.steps : [];
  if (steps.length === 0) {
    const label =
      result?.status === "infra_error"
        ? "runner infra error"
        : result?.status === "not_run"
          ? "not executed"
          : "no steps recorded";
    strip.appendChild(el("span", "proof-pill", label));
    return strip;
  }

  steps.forEach((step, idx) => {
    const safeStepStatus = sanitizeStatus(step.status, VALID_STEP_STATUSES, "skipped");
    const stepWrap = el("div", `proof-step is-${safeStepStatus}`);
    const node = el("div", "proof-node");
    const pill = el("span", "proof-pill", `${statusSymbol(safeStepStatus)} ${step.id}`);
    node.appendChild(pill);

    if (result.firstFailedStepId && step.id === result.firstFailedStepId) {
      node.appendChild(el("span", "proof-marker", "▲ first failure"));
    }

    stepWrap.appendChild(node);

    if (idx < steps.length - 1) {
      const connector = el("span", "proof-connector");
      connector.setAttribute("aria-hidden", "true");
      stepWrap.appendChild(connector);
    }

    strip.appendChild(stepWrap);
  });

  return strip;
}

function renderPlatformSummaryCell(platformId, result) {
  const safeStatus = sanitizeStatus(result?.status, VALID_PLATFORM_STATUSES, "infra_error");
  const cell = el("div", `platform-cell is-${safeStatus}`);

  const head = el("div", "platform-cell-head");
  const left = el("div", "platform-cell-left");
  left.appendChild(el("span", "platform-name", PLATFORM_LABELS[platformId]));
  left.appendChild(
    el("span", `status-badge is-compact badge-${safeStatus}`, compactStatusLabel(safeStatus)),
  );
  head.appendChild(left);

  const right = el("div", "platform-cell-right");
  if (result?.resolvedVersion) {
    right.appendChild(el("span", "", `v${result.resolvedVersion}`));
  }
  right.appendChild(el("span", "", formatDuration(result?.durationMs)));
  head.appendChild(right);

  cell.appendChild(head);
  cell.appendChild(renderProofStrip(platformId, result));
  return cell;
}

function indexHistoryByTarget(historyDays) {
  const byTarget = new Map();
  if (!Array.isArray(historyDays)) {
    return byTarget;
  }
  for (const day of historyDays) {
    if (!day || !Array.isArray(day.targets)) continue;
    for (const entry of day.targets) {
      if (!entry || typeof entry.id !== "string" || !entry.platforms) continue;
      let list = byTarget.get(entry.id);
      if (!list) {
        list = [];
        byTarget.set(entry.id, list);
      }
      list.push({ date: day.date, entry });
    }
  }
  return byTarget;
}

function renderHistoryStrip(targetId, matching) {
  if (!Array.isArray(matching) || matching.length === 0) {
    return null;
  }

  const row = el("div", "history-row");
  row.setAttribute("aria-label", `Recent ${matching.length}-day history for ${targetId}`);
  row.appendChild(el("span", "history-label", `${matching.length}-day history`));

  const cells = el("div", "history-cells");
  for (const { date, entry } of matching) {
    const uStatus = sanitizeStatus(entry.platforms.ubuntu?.status, VALID_PLATFORM_STATUSES, "not_run");
    const wStatus = sanitizeStatus(entry.platforms.windows?.status, VALID_PLATFORM_STATUSES, "not_run");
    const uVer = entry.platforms.ubuntu?.resolvedVersion ? ` (${entry.platforms.ubuntu.resolvedVersion})` : "";
    const wVer = entry.platforms.windows?.resolvedVersion ? ` (${entry.platforms.windows.resolvedVersion})` : "";

    const dayEl = el("span", "history-day");
    const summaryText = `${date}: Ubuntu ${statusLabel(uStatus)}${uVer}, Windows ${statusLabel(wStatus)}${wVer}`;
    dayEl.title = summaryText;
    dayEl.setAttribute("aria-label", summaryText);

    dayEl.appendChild(el("span", "history-date", formatShortUtcDate(date)));
    dayEl.appendChild(el("span", `history-chip is-${uStatus}`, `U${statusSymbol(uStatus)}`));
    dayEl.appendChild(el("span", `history-chip is-${wStatus}`, `W${statusSymbol(wStatus)}`));
    cells.appendChild(dayEl);
  }

  row.appendChild(cells);
  return row;
}

function renderStepDetail(step) {
  const safeStatus = sanitizeStatus(step.status, VALID_STEP_STATUSES, "skipped");
  const block = el("div", `step-block is-${safeStatus}`);

  const head = el("div", "step-block-head");
  const cmdText = `$ ${step.command} ${(step.args || []).join(" ")}`.trim();
  head.appendChild(el("code", "step-cmd", cmdText));

  const stats = el("div", "step-stats");
  stats.appendChild(el("span", "", step.id));
  stats.appendChild(el("span", "", safeStatus.toUpperCase()));
  if (step.exitCode !== null && step.exitCode !== undefined) {
    stats.appendChild(el("span", "", `exit ${step.exitCode}`));
  }
  if (step.durationMs > 0) {
    stats.appendChild(el("span", "", formatDuration(step.durationMs)));
  }
  head.appendChild(stats);
  block.appendChild(head);

  if (Array.isArray(step.assertions) && step.assertions.length > 0) {
    const list = el("ul", "assertions-list");
    for (const a of step.assertions) {
      const li = el(
        "li",
        a.passed ? "assertion-pass" : "assertion-fail",
        `${a.passed ? "✓" : "✕"} ${a.kind}: expected ${a.expected} (${a.observed})`,
      );
      list.appendChild(li);
    }
    block.appendChild(list);
  }

  if (step.stderr && step.stderr.trim().length > 0) {
    block.appendChild(
      el("div", "evidence-label", step.stderrTruncated ? "stderr (truncated, redacted)" : "stderr (redacted)"),
    );
    block.appendChild(el("pre", "evidence-pre", step.stderr.trim()));
  }

  const showStdout =
    step.stdout &&
    step.stdout.trim().length > 0 &&
    (step.id !== "resolved-version" || safeStatus !== "passed");
  if (showStdout) {
    block.appendChild(
      el("div", "evidence-label", step.stdoutTruncated ? "stdout (truncated, redacted)" : "stdout (redacted)"),
    );
    block.appendChild(el("pre", "evidence-pre", step.stdout.trim()));
  }

  return block;
}

function renderPlatformEvidenceSection(platformId, result) {
  const safeStatus = sanitizeStatus(result?.status, VALID_PLATFORM_STATUSES, "infra_error");
  const section = el("div", "platform-evidence-section");

  const head = el("div", "platform-evidence-head");
  const title = el("div", "platform-evidence-title");
  title.appendChild(el("span", "", `${PLATFORM_LABELS[platformId]} evidence`));
  title.appendChild(el("span", `status-badge is-compact badge-${safeStatus}`, statusLabel(safeStatus)));
  head.appendChild(title);

  const facts = el("div", "detail-facts");
  if (result?.resolvedVersion) {
    facts.appendChild(el("span", "", `version ${result.resolvedVersion}`));
  }
  const checkedEl = el("time", "", `checked ${formatLocalTime(result?.checkedAt)}`);
  checkedEl.dateTime = result?.checkedAt || "";
  checkedEl.title = result?.checkedAt || "";
  facts.appendChild(checkedEl);
  if (result?.fingerprint) {
    facts.appendChild(el("span", "", `fingerprint ${result.fingerprint}`));
  }
  if (result?.failureCategory) {
    facts.appendChild(el("span", "", `category ${result.failureCategory}`));
  }
  head.appendChild(facts);
  section.appendChild(head);

  if (result?.notRunReason) {
    section.appendChild(el("div", "notice-box", `Not run: ${result.notRunReason}`));
  }

  if (result?.infraErrorMessage) {
    section.appendChild(
      el("div", "notice-box is-infra", `Infrastructure error: ${result.infraErrorMessage}`),
    );
  }

  if (Array.isArray(result?.steps) && result.steps.length > 0) {
    const stepsWrap = el("div", "steps-table");
    for (const step of result.steps) {
      stepsWrap.appendChild(renderStepDetail(step));
    }
    section.appendChild(stepsWrap);
  }

  return section;
}

function renderTargetRow(target, historyDays) {
  const safeAgg = sanitizeStatus(target.aggregateStatus, VALID_AGGREGATE_STATUSES, "incomplete");
  const details = el("details", "target-row");
  if (safeAgg === "failed" || safeAgg === "infra_error") {
    details.open = true;
  }

  const summary = el("summary", "target-summary");
  const header = el("div", "target-header");

  const identity = el("div", "target-identity");
  const titleLine = el("div", "target-title-line");
  titleLine.appendChild(el("span", "target-name", target.name));

  const uVer = target.results?.ubuntu?.resolvedVersion ?? null;
  const wVer = target.results?.windows?.resolvedVersion ?? null;
  const pkgLabel =
    uVer && wVer && uVer === wVer
      ? `${target.package}@${uVer}`
      : uVer && !wVer
        ? `${target.package}@${uVer}`
        : !uVer && wVer
          ? `${target.package}@${wVer}`
          : target.package;
  titleLine.appendChild(el("span", "target-package", pkgLabel));

  if (target.versionDrift) {
    const drift = el("span", "drift-pill", "VERSION DRIFT");
    drift.title = `Ubuntu resolved ${uVer ?? "unknown"}, Windows resolved ${wVer ?? "unknown"}`;
    titleLine.appendChild(drift);
  }

  identity.appendChild(titleLine);
  identity.appendChild(el("p", "target-scope", `Scope: ${target.scope}`));
  header.appendChild(identity);

  header.appendChild(el("span", `status-badge badge-${safeAgg}`, statusLabel(safeAgg)));

  const toggle = el("span", "target-toggle");
  toggle.appendChild(el("span", "target-toggle-closed", "[open]"));
  toggle.appendChild(el("span", "target-toggle-open", "[close]"));
  header.appendChild(toggle);

  summary.appendChild(header);

  const grid = el("div", "platform-grid");
  for (const platformId of PLATFORMS) {
    grid.appendChild(renderPlatformSummaryCell(platformId, target.results?.[platformId]));
  }
  summary.appendChild(grid);

  const historyRow = renderHistoryStrip(target.id, historyDays);
  if (historyRow) {
    summary.appendChild(historyRow);
  }

  details.appendChild(summary);

  const drawer = el("div", "target-details");

  const metaBar = el("div", "detail-meta-bar");
  const links = el("div", "detail-links");
  const addLink = (href, label, isRelative = false) => {
    const resolved = isRelative ? href : safeHttpsUrl(href);
    if (!resolved) return;
    const a = el("a", "link", label);
    a.href = resolved;
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    links.appendChild(a);
  };
  addLink(target.docsUrl, "Official docs");
  addLink(target.repositoryUrl, "Repository");
  if (
    typeof target.contractPath === "string" &&
    /^[A-Za-z0-9._/-]+$/.test(target.contractPath) &&
    !target.contractPath.startsWith("/") &&
    !target.contractPath.includes("..")
  ) {
    addLink(`${REPO_BASE}/blob/main/${encodeURI(target.contractPath)}`, "Contract JSON");
  }
  if (typeof target.id === "string" && SAFE_SLUG_REGEX.test(target.id)) {
    addLink(`./badges/${target.id}-ubuntu.json`, "Ubuntu badge JSON", true);
    addLink(`./badges/${target.id}-windows.json`, "Windows badge JSON", true);
  }
  metaBar.appendChild(links);
  drawer.appendChild(metaBar);

  if (target.versionDrift) {
    drawer.appendChild(
      el(
        "div",
        "notice-box is-infra",
        `Version drift observed: Ubuntu installed ${uVer ?? "unknown"} while Windows installed ${wVer ?? "unknown"}. Drift is informational and does not fail a passing check.`,
      ),
    );
  }

  for (const platformId of PLATFORMS) {
    drawer.appendChild(renderPlatformEvidenceSection(platformId, target.results?.[platformId]));
  }

  details.appendChild(drawer);
  return details;
}

async function fetchOptionalHistory() {
  try {
    const res = await fetch("./history.json", { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.days)) {
      return [];
    }
    return data.days.slice(-7);
  } catch {
    return [];
  }
}

async function boot() {
  const banner = document.getElementById("state-banner");
  const list = document.getElementById("targets-list");
  const envStrip = document.getElementById("platform-env-strip");
  const lastRunEl = document.getElementById("last-run");
  const commitWrap = document.getElementById("commit-wrap");
  const commitLink = document.getElementById("commit-link");

  try {
    const [statusRes, historyDays] = await Promise.all([
      fetch("./status.json", { cache: "no-store" }),
      fetchOptionalHistory(),
    ]);

    if (!statusRes.ok) {
      throw new Error(`HTTP ${statusRes.status}`);
    }
    const rawStatus = await statusRes.json();
    const data = parseStatusDocument(rawStatus);

    lastRunEl.textContent = formatLocalTime(data.generatedAt);
    lastRunEl.dateTime = data.generatedAt || "";
    lastRunEl.title = data.generatedAt || "";

    if (typeof data.sourceCommit === "string" && /^[0-9a-f]{7,40}$/i.test(data.sourceCommit)) {
      commitLink.textContent = data.sourceCommit;
      commitLink.href = `${REPO_BASE}/commit/${encodeURIComponent(data.sourceCommit)}`;
      commitWrap.hidden = false;
    }

    renderPlatformEnvironments(envStrip, data.platforms);

    const setStat = (id, count) => {
      const node = document.getElementById(id);
      const val = Number(count ?? 0);
      node.textContent = String(val);
      node.classList.toggle("is-zero", val === 0);
    };
    setStat("count-pass", data.summary?.passed);
    setStat("count-fail", data.summary?.failed);
    setStat("count-infra", data.summary?.infraErrors);
    setStat("count-incomplete", data.summary?.incomplete);

    const checksNode = document.getElementById("count-checks");
    const passedChecks = Number(data.summary?.platformPassed ?? 0);
    const totalChecks = Number(data.summary?.platformChecks ?? 0);
    checksNode.textContent = `${passedChecks}/${totalChecks}`;
    checksNode.classList.toggle("is-zero", totalChecks === 0);

    list.replaceChildren();
    if (data.targets.length === 0) {
      banner.textContent = "No quickstart contracts were recorded in this run.";
      banner.hidden = false;
      list.hidden = true;
      return;
    }

    const historyByTarget = indexHistoryByTarget(historyDays);
    for (const target of data.targets) {
      list.appendChild(renderTargetRow(target, historyByTarget.get(target.id)));
    }

    if (data.legacyV1) {
      banner.textContent =
        "Showing a legacy schema v1 snapshot (Ubuntu only). Windows results will appear after the next scheduled run.";
      banner.classList.add("is-notice");
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }

    list.hidden = false;
  } catch {
    banner.textContent = "Status data could not be loaded.";
    banner.classList.add("is-error");
    banner.hidden = false;
    list.hidden = true;
  }
}

boot();
