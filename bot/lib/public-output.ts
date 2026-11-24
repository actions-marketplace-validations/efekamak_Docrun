import { redactSecrets, stripAnsi, truncateUtf8 } from "./execute.js";

export const DEFAULT_PUBLIC_EXCERPT_BYTES = 4_096;

export const LOCAL_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/(^|[\s"'`(,=])[A-Za-z]:\\[^\s"'`:]{0,240}docrun-[A-Za-z0-9_-]+/g, "$1<temp-workspace>"],
  [/(^|[\s"'`(,=/])[A-Za-z]:\/[^\s"'`:]{0,240}docrun-[A-Za-z0-9_-]+/g, "$1<temp-workspace>"],
  [/(^|[\s"'`(,=:])\/[^\s"'`:]{0,240}docrun-[A-Za-z0-9_-]+/g, "$1<temp-workspace>"],
  [/[A-Za-z]:\\Users\\[^\\\s"'`<>|)]+/g, "<local-user>"],
  [/[A-Za-z]:\/Users\/[^/\s"'`<>|)]+/g, "<local-user>"],
  [/\/(?:Users|home)\/[^/\s"'`<>|)]+/g, "<local-user>"],
  [/[A-Za-z]:\\a\\[^\\\s"'`<>|)]+/g, "<runner-workspace>"],
];

export type PublicSanitizeOptions = {
  extraPathReplacements?: Array<{ path: string; replacement: string }>;
};

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replacePathVariants(text: string, targetPath: string, replacement: string): string {
  const trimmed = targetPath.trim();
  if (trimmed.length === 0) {
    return text;
  }

  const variants = new Set<string>([trimmed]);
  const forward = trimmed.replace(/\\/g, "/");
  const backward = trimmed.replace(/\//g, "\\");
  variants.add(forward);
  variants.add(backward);
  for (const variant of [...variants]) {
    const withoutTrailing = variant.replace(/[\\/]+$/, "");
    if (withoutTrailing.length > 0) {
      variants.add(withoutTrailing);
    }
  }

  const sorted = [...variants].sort((a, b) => b.length - a.length);
  let out = text;
  for (const variant of sorted) {
    const flags = process.platform === "win32" ? "gi" : "g";
    out = out.replace(new RegExp(escapeRegExp(variant), flags), replacement);
  }
  return out;
}

export function scrubPublicText(text: string, options?: PublicSanitizeOptions): string {
  let clean = stripAnsi(text);

  if (options?.extraPathReplacements) {
    const sorted = [...options.extraPathReplacements].sort(
      (a, b) => b.path.length - a.path.length,
    );
    for (const entry of sorted) {
      clean = replacePathVariants(clean, entry.path, entry.replacement);
    }
  }

  clean = redactSecrets(clean);

  for (const [pattern, replacement] of LOCAL_PATH_PATTERNS) {
    clean = clean.replace(pattern, replacement);
  }

  return clean;
}

export function sanitizePublicExcerpt(
  text: string,
  maxBytes: number = DEFAULT_PUBLIC_EXCERPT_BYTES,
  options?: PublicSanitizeOptions,
): { text: string; truncated: boolean } {
  const clean = scrubPublicText(text, options);
  return truncateUtf8(clean, maxBytes);
}
