/**
 * The `{{ path }}` placeholder renderer shared by notification message templates
 * (`src/server/notifications/message.ts`) and incident / maintenance templates
 * (`src/lib/templates.ts`).
 *
 * Deliberately tiny and safe: a placeholder is a plain dotted identifier path (`{{ monitor.name }}`),
 * resolved by a callback against plain data. There are no expressions, filters or code, so a
 * template can never execute anything or reach outside the values it is given. Liquid templates
 * (#150) will replace this module; callers only depend on `renderPlaceholders` and
 * `findPlaceholders`.
 *
 * Client-safe: no server-only imports.
 */

/** `{{ name }}` or `{{ a.b.c }}` with optional spaces inside the braces. */
export const PLACEHOLDER_PATTERN =
  /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g

/**
 * Value of a placeholder path, or `undefined` to leave the placeholder in the text unchanged
 * (incident templates keep `{{ eta }}` for the author to fill in).
 */
export type PlaceholderResolver = (path: string) => string | undefined

/** Replaces every placeholder the resolver knows; unresolved ones stay as written. */
export function renderPlaceholders(template: string, resolve: PlaceholderResolver): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, path: string) => resolve(path) ?? match)
}

/** Fenced code blocks and inline code spans, which may legitimately contain `{{ … }}`. */
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g

/**
 * Distinct placeholder paths left in `texts`, in order of first appearance. Markdown code (inline
 * spans and fenced blocks) is ignored, so documentation of a template syntax can still be posted.
 */
export function findPlaceholders(...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    for (const match of text.replace(CODE, '').matchAll(PLACEHOLDER_PATTERN)) found.add(match[1])
  }
  return [...found]
}
