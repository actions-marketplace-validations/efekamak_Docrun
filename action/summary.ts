import { renderStepCommand, type QuickstartStep } from "../bot/lib/contract.js";
import type { QuickstartRunResult, StepResult } from "../bot/lib/execute.js";
import {
  sanitizePublicExcerpt,
  type PublicSanitizeOptions,
} from "../bot/lib/public-output.js";

export const SUMMARY_LIMITS = {
  MAX_SUMMARY_BYTES: 32_768,
  MAX_EVIDENCE_BYTES: 8_192,
  MAX_VALIDATION_ERRORS_SHOWN: 20,
} as const;

export type DeclaredStepSummary = Pick<QuickstartStep, "id" | "command" | "args">;

export type SummaryRenderOptions = {
  contractPath?: string;
  declaredSteps?: DeclaredStepSummary[];
  sanitizeOptions?: PublicSanitizeOptions;
  maxSummaryBytes?: number;
  maxEvidenceBytes?: number;
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeEscapedText(
  value: string,
  maxBytes: number,
  sanitizeOptions?: PublicSanitizeOptions,
): string {
  return escapeHtml(sanitizePublicExcerpt(value, maxBytes, sanitizeOptions).text);
}

type StepRow = {
  id: string;
  command: string;
  status: "passed" | "failed" | "timed_out" | "skipped";
  exitCode: string;
  duration: string;
};

function buildStepRows(
  result: QuickstartRunResult,
  declaredSteps: DeclaredStepSummary[] | undefined,
  sanitizeOptions?: PublicSanitizeOptions,
): StepRow[] {
  const executedById = new Map<string, StepResult>(result.steps.map((step) => [step.id, step]));

  if (declaredSteps && declaredSteps.length > 0) {
    return declaredSteps.map((declared) => {
      const executed = executedById.get(declared.id);
      if (!executed) {
        return {
          id: declared.id,
          command: sanitizePublicExcerpt(
            renderStepCommand(declared),
            240,
            sanitizeOptions,
          ).text,
          status: "skipped",
          exitCode: "-",
          duration: "-",
        };
      }
      return {
        id: executed.id,
        command: sanitizePublicExcerpt(renderStepCommand(executed), 240, sanitizeOptions).text,
        status: executed.status,
        exitCode: executed.exitCode === null ? "-" : String(executed.exitCode),
        duration: `${executed.durationMs} ms`,
      };
    });
  }

  return result.steps.map((executed) => ({
    id: executed.id,
    command: sanitizePublicExcerpt(renderStepCommand(executed), 240, sanitizeOptions).text,
    status: executed.status,
    exitCode: executed.exitCode === null ? "-" : String(executed.exitCode),
    duration: `${executed.durationMs} ms`,
  }));
}

function buildEvidenceHtml(
  result: QuickstartRunResult,
  evidenceBudgetBytes: number,
  sanitizeOptions?: PublicSanitizeOptions,
): string {
  if (result.status !== "failed") {
    return "";
  }

  const failedStep = result.firstFailedStepId
    ? result.steps.find((step) => step.id === result.firstFailedStepId) ?? null
    : null;

  if (!failedStep && result.failedAssertions.length === 0) {
    return "";
  }

  if (evidenceBudgetBytes <= 0) {
    return "<p>Failure evidence omitted to fit GitHub Step Summary size limit.</p>";
  }

  const parts: string[] = ["<h4>Failure evidence</h4>"];

  if (result.failedAssertions.length > 0) {
    parts.push("<ul>");
    for (const assertion of result.failedAssertions.slice(0, 10)) {
      const kind = escapeHtml(assertion.kind);
      const expected = safeEscapedText(assertion.expected, 256, sanitizeOptions);
      const observed = safeEscapedText(assertion.observed, 256, sanitizeOptions);
      parts.push(
        `<li><code>${kind}</code>: expected <code>${expected}</code>, observed <code>${observed}</code></li>`,
      );
    }
    parts.push("</ul>");
  }

  if (failedStep) {
    const sections: Array<{ label: string; text: string }> = [];
    if (failedStep.stderr.trim().length > 0) {
      sections.push({ label: "stderr", text: failedStep.stderr });
    }
    if (failedStep.stdout.trim().length > 0) {
      sections.push({ label: "stdout", text: failedStep.stdout });
    }

    if (sections.length > 0) {
      const perSectionRawBudget = Math.max(
        128,
        Math.floor(evidenceBudgetBytes / sections.length) - 120,
      );

      for (const section of sections) {
        let limit = perSectionRawBudget;
        let renderedSection = "";
        while (limit >= 64) {
          const bounded = sanitizePublicExcerpt(section.text, limit, sanitizeOptions);
          const escaped = escapeHtml(bounded.text);
          const candidate = `<p><strong>${section.label}</strong> (${escapeHtml(failedStep.id)})</p><pre><code>${escaped}</code></pre>`;
          if (Buffer.byteLength(candidate, "utf8") <= Math.floor(evidenceBudgetBytes / sections.length) + 64) {
            renderedSection = candidate;
            break;
          }
          limit = Math.floor(limit * 0.65);
        }
        if (renderedSection.length > 0) {
          parts.push(renderedSection);
        }
      }
    }
  }

  const combined = parts.join("\n");
  if (Buffer.byteLength(combined, "utf8") <= evidenceBudgetBytes) {
    return combined;
  }

  // Fallback to a compact assertion/stderr snippet that strictly stays under evidenceBudgetBytes.
  if (failedStep) {
    const rawFallback = failedStep.stderr.trim() || failedStep.stdout.trim();
    if (rawFallback.length > 0) {
      let limit = Math.max(64, Math.floor(evidenceBudgetBytes * 0.5));
      while (limit >= 64) {
        const bounded = sanitizePublicExcerpt(rawFallback, limit, sanitizeOptions);
        const candidate = `<h4>Failure evidence</h4>\n<pre><code>${escapeHtml(bounded.text)}</code></pre>`;
        if (Buffer.byteLength(candidate, "utf8") <= evidenceBudgetBytes) {
          return candidate;
        }
        limit = Math.floor(limit * 0.6);
      }
    }
  }

  return "<p>Failure evidence omitted to fit size limit.</p>";
}

function renderDocument(params: {
  result: QuickstartRunResult;
  contractPath?: string;
  stepRows: StepRow[];
  maxStepsShown: number;
  maxValidationErrorsShown: number;
  evidenceBudgetBytes: number;
  sanitizeOptions?: PublicSanitizeOptions;
}): string {
  const {
    result,
    contractPath,
    stepRows,
    maxStepsShown,
    maxValidationErrorsShown,
    evidenceBudgetBytes,
    sanitizeOptions,
  } = params;

  const contractLabel = contractPath
    ? `${result.contractName} (${contractPath})`
    : result.contractName;

  const runnerValue = result.pythonVersion
    ? `<code>${escapeHtml(result.platform)}</code> / <code>${escapeHtml(result.nodeVersion)}</code> / <code>Python ${escapeHtml(result.pythonVersion)}</code>`
    : `<code>${escapeHtml(result.platform)}</code> / <code>${escapeHtml(result.nodeVersion)}</code>`;

  const metaRows: Array<[string, string]> = [
    ["Status", escapeHtml(result.status)],
    ["Contract", `<code>${safeEscapedText(contractLabel, 240, sanitizeOptions)}</code>`],
    ["Duration", `${Math.max(0, Math.round(result.durationMs))} ms`],
    ["Runner", runnerValue],
  ];

  if (result.failureCategory) {
    metaRows.push(["Failure category", `<code>${escapeHtml(result.failureCategory)}</code>`]);
  }
  if (result.firstFailedStepId) {
    metaRows.push([
      "First failed step",
      `<code>${safeEscapedText(result.firstFailedStepId, 120, sanitizeOptions)}</code>`,
    ]);
  }
  if (result.fingerprint) {
    metaRows.push(["Fingerprint", `<code>${escapeHtml(result.fingerprint)}</code>`]);
  }

  const lines: string[] = [
    `<h3>docrun: ${escapeHtml(result.status)}</h3>`,
    "<table><tbody>",
    ...metaRows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`),
    "</tbody></table>",
  ];

  if (result.status === "invalid" && result.validationErrors.length > 0) {
    lines.push("<h4>Validation errors</h4>");
    lines.push("<ul>");
    const visibleErrors = result.validationErrors.slice(0, maxValidationErrorsShown);
    for (const err of visibleErrors) {
      lines.push(`<li><code>${safeEscapedText(err, 512, sanitizeOptions)}</code></li>`);
    }
    if (result.validationErrors.length > visibleErrors.length) {
      lines.push(
        `<li>... ${result.validationErrors.length - visibleErrors.length} more validation error(s) omitted</li>`,
      );
    }
    lines.push("</ul>");
  }

  if (result.readmeDrift.checked && !result.readmeDrift.ok && result.readmeDrift.reason) {
    lines.push("<h4>README drift</h4>");
    lines.push(
      `<p>${safeEscapedText(result.readmeDrift.reason, 512, sanitizeOptions)}</p>`,
    );
  }

  if (stepRows.length > 0) {
    lines.push("<h4>Steps</h4>");
    lines.push(
      "<table><thead><tr><th>Step</th><th>Command</th><th>Status</th><th>Exit</th><th>Duration</th></tr></thead><tbody>",
    );
    const visibleSteps = stepRows.slice(0, maxStepsShown);
    for (const row of visibleSteps) {
      lines.push(
        `<tr><td><code>${safeEscapedText(row.id, 120, sanitizeOptions)}</code></td><td><code>${escapeHtml(row.command)}</code></td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.exitCode)}</td><td>${escapeHtml(row.duration)}</td></tr>`,
      );
    }
    if (stepRows.length > visibleSteps.length) {
      lines.push(
        `<tr><td colspan="5">... ${stepRows.length - visibleSteps.length} more step(s) omitted</td></tr>`,
      );
    }
    lines.push("</tbody></table>");
  }

  const evidenceHtml = buildEvidenceHtml(result, evidenceBudgetBytes, sanitizeOptions);
  if (evidenceHtml.length > 0) {
    lines.push(evidenceHtml);
  }

  return `${lines.join("\n")}\n`;
}

export function renderStepSummary(
  result: QuickstartRunResult,
  options: SummaryRenderOptions = {},
): string {
  const maxSummaryBytes = options.maxSummaryBytes ?? SUMMARY_LIMITS.MAX_SUMMARY_BYTES;
  const maxEvidenceBytes = Math.min(
    options.maxEvidenceBytes ?? SUMMARY_LIMITS.MAX_EVIDENCE_BYTES,
    maxSummaryBytes,
  );
  const stepRows = buildStepRows(result, options.declaredSteps, options.sanitizeOptions);

  const evidenceBudgets = [
    maxEvidenceBytes,
    Math.min(maxEvidenceBytes, 4_096),
    Math.min(maxEvidenceBytes, 2_048),
    Math.min(maxEvidenceBytes, 1_024),
    0,
  ];

  for (const evidenceBudgetBytes of evidenceBudgets) {
    const html = renderDocument({
      result,
      contractPath: options.contractPath,
      stepRows,
      maxStepsShown: stepRows.length,
      maxValidationErrorsShown: SUMMARY_LIMITS.MAX_VALIDATION_ERRORS_SHOWN,
      evidenceBudgetBytes,
      sanitizeOptions: options.sanitizeOptions,
    });
    if (Buffer.byteLength(html, "utf8") <= maxSummaryBytes) {
      return html;
    }
  }

  // If still over budget even without evidence, trim step rows and validation errors cleanly.
  const stepCaps = [10, 5, 2, 0];
  const errCaps = [5, 2, 0];
  for (const maxStepsShown of stepCaps) {
    for (const maxValidationErrorsShown of errCaps) {
      const html = renderDocument({
        result,
        contractPath: options.contractPath,
        stepRows,
        maxStepsShown,
        maxValidationErrorsShown,
        evidenceBudgetBytes: 0,
        sanitizeOptions: options.sanitizeOptions,
      });
      if (Buffer.byteLength(html, "utf8") <= maxSummaryBytes) {
        return html;
      }
    }
  }

  return `<h3>docrun: ${escapeHtml(result.status)}</h3>\n<p>Summary omitted to fit size limit.</p>\n`;
}
