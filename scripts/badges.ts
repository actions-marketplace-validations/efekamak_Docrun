import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as z from "zod/v4";
import {
  REQUIRED_PLATFORMS,
  type AggregateStatusDocument,
  type AggregateTargetStatus,
  type PlatformTargetStatus,
} from "./status-v2.js";

const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_BADGE_FILENAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,80}\.json$/;

export const ShieldsColorSchema = z.enum(["green", "red", "orange", "lightgrey"]);
export type ShieldsColor = z.infer<typeof ShieldsColorSchema>;

export const ShieldsEndpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    label: z.string().min(1).max(64),
    message: z.string().min(1).max(64),
    color: ShieldsColorSchema,
  })
  .strict();

export type ShieldsEndpointBadge = z.infer<typeof ShieldsEndpointSchema>;

export function statusToBadgeColor(
  status: AggregateTargetStatus | PlatformTargetStatus,
): ShieldsColor {
  switch (status) {
    case "passed":
      return "green";
    case "failed":
      return "red";
    case "infra_error":
      return "orange";
    case "incomplete":
    case "not_run":
      return "lightgrey";
  }
}

function capText(text: string, maxLen: number = 64): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`;
}

export function formatOverallBadgeMessage(status: AggregateStatusDocument): string {
  const s = status.summary;
  switch (status.overallStatus) {
    case "passed":
      return capText(`${s.platformPassed}/${s.platformChecks} checks pass`);
    case "failed":
      return capText(`${s.platformFailed} failed, ${s.platformPassed} passed`);
    case "infra_error":
      return capText(`${s.platformInfraErrors} infra error, ${s.platformPassed} passed`);
    case "incomplete": {
      const incompleteCount = s.platformNotRun > 0 ? s.platformNotRun : s.incomplete;
      return capText(`${incompleteCount} incomplete, ${s.platformPassed} passed`);
    }
  }
}

function formatPlatformBadgeMessage(
  status: PlatformTargetStatus,
  resolvedVersion: string | null,
): string {
  switch (status) {
    case "passed":
      return capText(resolvedVersion ? `pass (${resolvedVersion})` : "pass");
    case "failed":
      return capText(resolvedVersion ? `fail (${resolvedVersion})` : "fail");
    case "infra_error":
      return "infra error";
    case "not_run":
      return "not run";
  }
}

export function generateBadges(
  status: AggregateStatusDocument,
): Map<string, ShieldsEndpointBadge> {
  const badges = new Map<string, ShieldsEndpointBadge>();

  const overallBadge = ShieldsEndpointSchema.parse({
    schemaVersion: 1,
    label: "docrun",
    message: formatOverallBadgeMessage(status),
    color: statusToBadgeColor(status.overallStatus),
  });
  badges.set("overall.json", overallBadge);

  for (const target of status.targets) {
    if (!SLUG_REGEX.test(target.id)) {
      throw new Error(`Unsafe target slug for badge filename: "${target.id}"`);
    }

    for (const platform of REQUIRED_PLATFORMS) {
      const result = target.results[platform];
      const filename = `${target.id}-${platform}.json`;
      if (!SAFE_BADGE_FILENAME_REGEX.test(filename)) {
        throw new Error(`Unsafe badge filename: "${filename}"`);
      }

      const badge = ShieldsEndpointSchema.parse({
        schemaVersion: 1,
        label: capText(`${target.id} (${platform})`),
        message: formatPlatformBadgeMessage(result.status, result.resolvedVersion),
        color: statusToBadgeColor(result.status),
      });
      badges.set(filename, badge);
    }
  }

  return badges;
}

export async function writeBadges(
  outBadgesDir: string,
  badges: Map<string, ShieldsEndpointBadge>,
): Promise<void> {
  await fs.mkdir(outBadgesDir, { recursive: true });
  for (const [filename, badge] of badges.entries()) {
    if (!SAFE_BADGE_FILENAME_REGEX.test(filename)) {
      throw new Error(`Refusing to write unsafe badge filename: "${filename}"`);
    }
    const validated = ShieldsEndpointSchema.parse(badge);
    await fs.writeFile(
      path.join(outBadgesDir, filename),
      `${JSON.stringify(validated, null, 2)}\n`,
      "utf8",
    );
  }
}
