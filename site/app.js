const REPO_BASE = "https://github.com/efekamak/Docrun";

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

function statusLabel(status) {
  switch (status) {
    case "passed":
      return "PASS";
    case "failed":
      return "FAIL";
    case "infra_error":
      return "INFRA ERROR";
    case "not_run":
      return "NOT RUN";
    default:
      return String(status || "UNKNOWN").toUpperCase();
  }
}

function stepSymbol(status) {
  switch (status) {
    case "passed":
      return "✓";
    case "failed":
    case "timed_out":
      return "✕";
    case "skipped":
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

function renderProofStrip(target) {
  const strip = el("div", "proof-strip");
  strip.setAttribute("aria-label", "Executed contract steps");

  if (!Array.isArray(target.steps) || target.steps.length === 0) {
    const empty = el("span", "proof-pill", target.status === "infra_error" ? "no steps executed" : "not executed");
    strip.appendChild(empty);
    return strip;
  }

  target.steps.forEach((step, idx) => {
    const stepWrap = el("div", `proof-step is-${step.status}`);
    const node = el("div", "proof-node");
    const pill = el("span", "proof-pill", `${stepSymbol(step.status)} ${step.id}`);
    node.appendChild(pill);

    if (target.firstFailedStepId && step.id === target.firstFailedStepId) {
      node.appendChild(el("span", "proof-marker", "▲ first failure"));
    }

    stepWrap.appendChild(node);

    if (idx < target.steps.length - 1) {
      const connector = el("span", "proof-connector");
      connector.setAttribute("aria-hidden", "true");
      stepWrap.appendChild(connector);
    }

    strip.appendChild(stepWrap);
  });

  return strip;
}

function renderStepDetail(step) {
  const block = el("div", `step-block is-${step.status}`);

  const head = el("div", "step-block-head");
  const cmdText = `$ ${step.command} ${(step.args || []).join(" ")}`.trim();
  head.appendChild(el("code", "step-cmd", cmdText));

  const stats = el("div", "step-stats");
  stats.appendChild(el("span", "", step.id));
  stats.appendChild(el("span", "", step.status.toUpperCase()));
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

  if (step.stdout && step.stdout.trim().length > 0 && step.id !== "resolved-version") {
    block.appendChild(
      el("div", "evidence-label", step.stdoutTruncated ? "stdout (truncated, redacted)" : "stdout (redacted)"),
    );
    block.appendChild(el("pre", "evidence-pre", step.stdout.trim()));
  }

  return block;
}

function renderTargetRow(target) {
  const details = el("details", "target-row");
  if (target.status === "failed" || target.status === "infra_error") {
    details.open = true;
  }

  const summary = el("summary", "target-summary");
  const header = el("div", "target-header");

  const identity = el("div", "target-identity");
  const titleLine = el("div", "target-title-line");
  titleLine.appendChild(el("span", "target-name", target.name));
  const pkgLabel = target.resolvedVersion
    ? `${target.package}@${target.resolvedVersion}`
    : target.package;
  titleLine.appendChild(el("span", "target-package", pkgLabel));
  identity.appendChild(titleLine);
  identity.appendChild(el("p", "target-scope", `Scope: ${target.scope}`));
  header.appendChild(identity);

  header.appendChild(el("span", `status-badge badge-${target.status}`, statusLabel(target.status)));
  header.appendChild(el("span", "target-duration", formatDuration(target.durationMs)));

  const toggle = el("span", "target-toggle");
  toggle.appendChild(el("span", "target-toggle-closed", "[open]"));
  toggle.appendChild(el("span", "target-toggle-open", "[close]"));
  header.appendChild(toggle);

  summary.appendChild(header);
  summary.appendChild(renderProofStrip(target));
  details.appendChild(summary);

  const drawer = el("div", "target-details");

  const metaBar = el("div", "detail-meta-bar");
  const links = el("div", "detail-links");
  const addLink = (href, label) => {
    const safeHref = safeHttpsUrl(href);
    if (!safeHref) return;
    const a = el("a", "link", label);
    a.href = safeHref;
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
  metaBar.appendChild(links);

  const facts = el("div", "detail-facts");
  const checkedEl = el("time", "", `checked ${formatLocalTime(target.checkedAt)}`);
  checkedEl.dateTime = target.checkedAt || "";
  checkedEl.title = target.checkedAt || "";
  facts.appendChild(checkedEl);
  if (target.fingerprint) {
    facts.appendChild(el("span", "", `fingerprint ${target.fingerprint}`));
  }
  if (target.failureCategory) {
    facts.appendChild(el("span", "", `category ${target.failureCategory}`));
  }
  metaBar.appendChild(facts);
  drawer.appendChild(metaBar);

  if (target.notRunReason) {
    drawer.appendChild(el("div", "notice-box", `Not run: ${target.notRunReason}`));
  }

  if (target.infraErrorMessage) {
    drawer.appendChild(
      el("div", "notice-box is-infra", `Infrastructure error: ${target.infraErrorMessage}`),
    );
  }

  if (Array.isArray(target.steps) && target.steps.length > 0) {
    const stepsWrap = el("div", "steps-table");
    for (const step of target.steps) {
      stepsWrap.appendChild(renderStepDetail(step));
    }
    drawer.appendChild(stepsWrap);
  }

  details.appendChild(drawer);
  return details;
}

async function boot() {
  const banner = document.getElementById("state-banner");
  const list = document.getElementById("targets-list");
  const lastRunEl = document.getElementById("last-run");
  const commitWrap = document.getElementById("commit-wrap");
  const commitLink = document.getElementById("commit-link");

  try {
    const res = await fetch("./status.json", { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.targets)) {
      throw new Error("Invalid status.json shape");
    }

    lastRunEl.textContent = formatLocalTime(data.generatedAt);
    lastRunEl.dateTime = data.generatedAt || "";
    lastRunEl.title = data.generatedAt || "";

    if (typeof data.sourceCommit === "string" && /^[0-9a-f]{7,40}$/i.test(data.sourceCommit)) {
      commitLink.textContent = data.sourceCommit;
      commitLink.href = `${REPO_BASE}/commit/${encodeURIComponent(data.sourceCommit)}`;
      commitWrap.hidden = false;
    }

    const setStat = (id, count) => {
      const node = document.getElementById(id);
      const val = Number(count ?? 0);
      node.textContent = String(val);
      node.classList.toggle("is-zero", val === 0);
    };
    setStat("count-pass", data.summary?.passed);
    setStat("count-fail", data.summary?.failed);
    setStat("count-infra", data.summary?.infraErrors);
    setStat("count-not-run", data.summary?.notRun);

    list.replaceChildren();
    if (data.targets.length === 0) {
      banner.textContent = "No quickstart contracts were recorded in this run.";
      banner.hidden = false;
      list.hidden = true;
      return;
    }

    for (const target of data.targets) {
      list.appendChild(renderTargetRow(target));
    }

    banner.hidden = true;
    list.hidden = false;
  } catch {
    banner.textContent = "Status data could not be loaded.";
    banner.classList.add("is-error");
    banner.hidden = false;
    list.hidden = true;
  }
}

boot();
