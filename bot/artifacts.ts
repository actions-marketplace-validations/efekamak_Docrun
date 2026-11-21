import { defineArtifacts } from "@grok/agent-sdk/artifacts";
import * as z from "zod/v4";
import { FAILURE_CATEGORIES } from "./lib/contract.js";

const FailureCategorySchema = z.enum(FAILURE_CATEGORIES);

export default defineArtifacts({
  kinds: {
    "quickstart-run": {
      description:
        "Deterministic structured evidence from executing a docrun.json contract in a fresh temporary workspace.",
      schema: z.object({
        runId: z.string(),
        contractName: z.string(),
        status: z.enum(["passed", "failed", "invalid"]),
        failureCategory: FailureCategorySchema.nullable(),
        firstFailedStepId: z.string().nullable(),
        durationMs: z.number(),
        fingerprint: z.string().nullable(),
      }),
    },
    "quickstart-report": {
      description:
        "Concise maintainer-facing Markdown report derived strictly from a quickstart-run result.",
      schema: z.object({
        contractName: z.string(),
        status: z.enum(["passed", "failed", "invalid"]),
        failureCategory: FailureCategorySchema.nullable(),
        firstFailedStepId: z.string().nullable(),
        fingerprint: z.string().nullable(),
        summary: z.string(),
      }),
    },
  },
  agentTool: true,
});
