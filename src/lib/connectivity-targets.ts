/**
 * Parser for `CONNECTIVITY_CHECK_TARGETS`, the probe list of the worker's self connectivity check
 * (`src/server/engine/connectivity.ts`).
 *
 * `src/env.ts` is part of the browser bundle, so this module must not import Node built-ins.
 * Entries are separated by commas or whitespace and are either `host:port` (a TCP connect,
 * `[v6]:port` for IPv6) or an `http://` / `https://` URL (any HTTP response counts).
 */

export type ConnectivityTarget =
  | { kind: 'tcp'; label: string; host: string; port: number }
  | { kind: 'http'; label: string; url: string }

/** Parse one entry, or explain why it is invalid. */
function parseEntry(entry: string): ConnectivityTarget | string {
  if (/^https?:\/\//i.test(entry)) {
    try {
      const url = new URL(entry)
      return { kind: 'http', label: entry, url: url.toString() }
    } catch {
      return `"${entry}" is not a valid URL`
    }
  }
  const match = entry.match(/^(?:\[([^\]]+)\]|([^:\s[\]]+)):(\d{1,5})$/)
  if (!match) return `"${entry}" must be host:port or an http(s):// URL`
  const port = Number(match[3])
  if (port < 1 || port > 65535) return `"${entry}" has an invalid port`
  return { kind: 'tcp', label: entry, host: match[1] ?? match[2], port }
}

/** Every target of the list; invalid entries throw. */
export function parseConnectivityTargets(raw: string): ConnectivityTarget[] {
  const targets: ConnectivityTarget[] = []
  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    const parsed = parseEntry(entry)
    if (typeof parsed === 'string') throw new Error(parsed)
    targets.push(parsed)
  }
  return targets
}

/** Why `raw` is not a valid target list, or `null`. An empty list is invalid. */
export function connectivityTargetsError(raw: string): string | null {
  try {
    return parseConnectivityTargets(raw).length > 0 ? null : 'list at least one target'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
