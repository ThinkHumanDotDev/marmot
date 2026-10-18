/**
 * Scripted browser checks (#139): what a `browser-script` check reports besides its verdict.
 * Shared by the worker (which produces it), the heartbeat (`heartbeats.browser`), the on-demand
 * check result and the UI, so it must stay free of Node-only imports.
 */

/** Monitor type name. */
export const BROWSER_SCRIPT_TYPE = 'browser-script'

/** When screenshots and traces are kept (`monitors.browserArtifacts`). */
export const BROWSER_ARTIFACT_MODES = ['failure', 'always'] as const
export type BrowserArtifactMode = (typeof BROWSER_ARTIFACT_MODES)[number]

/** Kinds of stored check artifacts (`check-artifacts.kind`). */
export const CHECK_ARTIFACT_KINDS = ['screenshot', 'trace'] as const
export type CheckArtifactKind = (typeof CHECK_ARTIFACT_KINDS)[number]

/** Upper bound of a script (characters). */
export const BROWSER_SCRIPT_MAX_LENGTH = 20_000
/** Upper bound of the variables and secrets of one monitor. */
export const BROWSER_SCRIPT_MAX_VARIABLES = 50
/** Variable names: identifiers, so `vars.email` works. */
export const BROWSER_SCRIPT_VARIABLE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/

/** Caps of the lists stored per check. */
export const BROWSER_LIST_LIMIT = 50
export const BROWSER_TEXT_LIMIT = 1_000

/** One `test.step()` of the script, in the order the steps started. */
export interface BrowserStep {
  name: string
  /** Nesting level (0 for top-level steps). */
  depth: number
  /** Start, in ms since the script started. */
  startMs: number
  durationMs: number | null
  /** Error message when the step failed. */
  error: string | null
}

export interface BrowserFailedRequest {
  method: string
  url: string
  /** HTTP status of a response >= 400; `null` when the request failed outright. */
  status: number | null
  /** Network error (`net::ERR_NAME_NOT_RESOLVED`, `blocked by the outbound address guard`). */
  error: string | null
}

export interface BrowserLogLine {
  level: string
  text: string
}

/** Web Vitals of the last page the script was on, in ms (CLS is unitless); `null` when unknown. */
export interface BrowserWebVitals {
  ttfb: number | null
  fcp: number | null
  lcp: number | null
  cls: number | null
  domContentLoaded: number | null
  load: number | null
}

/** A stored screenshot or trace (`check-artifacts`). */
export interface BrowserArtifactRef {
  id: string
  kind: CheckArtifactKind
  url: string
  filename: string
  filesize: number | null
}

/** Stored on the heartbeat (`heartbeats.browser`) and returned by on-demand checks. */
export interface BrowserCheckDetails {
  steps: BrowserStep[]
  consoleErrors: string[]
  failedRequests: BrowserFailedRequest[]
  logs: BrowserLogLine[]
  webVitals: BrowserWebVitals | null
  /** URL of the page when the script ended. */
  finalUrl: string | null
  /** Stored artifacts (recorded checks). */
  artifacts?: BrowserArtifactRef[]
  /** Unrecorded runs (the editor's "Run now"): the screenshot as a `data:` URL, nothing stored. */
  screenshotDataUrl?: string | null
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Defensive parse of `heartbeats.browser` / an on-demand result's `browser` (JSON from anywhere). */
export function parseBrowserDetails(value: unknown): BrowserCheckDetails | null {
  if (!isObject(value)) return null
  const list = (input: unknown) => (Array.isArray(input) ? input : [])
  const vitals = isObject(value.webVitals) ? value.webVitals : null
  return {
    steps: list(value.steps)
      .filter(isObject)
      .map((step) => ({
        name: str(step.name) ?? '',
        depth: num(step.depth) ?? 0,
        startMs: num(step.startMs) ?? 0,
        durationMs: num(step.durationMs),
        error: str(step.error),
      })),
    consoleErrors: list(value.consoleErrors).filter(
      (item): item is string => typeof item === 'string',
    ),
    failedRequests: list(value.failedRequests)
      .filter(isObject)
      .map((request) => ({
        method: str(request.method) ?? 'GET',
        url: str(request.url) ?? '',
        status: num(request.status),
        error: str(request.error),
      })),
    logs: list(value.logs)
      .filter(isObject)
      .map((line) => ({ level: str(line.level) ?? 'log', text: str(line.text) ?? '' })),
    webVitals: vitals
      ? {
          ttfb: num(vitals.ttfb),
          fcp: num(vitals.fcp),
          lcp: num(vitals.lcp),
          cls: num(vitals.cls),
          domContentLoaded: num(vitals.domContentLoaded),
          load: num(vitals.load),
        }
      : null,
    finalUrl: str(value.finalUrl),
    artifacts: list(value.artifacts)
      .filter(isObject)
      .flatMap((artifact) => {
        const kind = artifact.kind
        if (kind !== 'screenshot' && kind !== 'trace') return []
        const url = str(artifact.url)
        if (!url) return []
        return [
          {
            id: String(artifact.id ?? ''),
            kind,
            url,
            filename: str(artifact.filename) ?? kind,
            filesize: num(artifact.filesize),
          },
        ]
      }),
    screenshotDataUrl:
      typeof value.screenshotDataUrl === 'string' &&
      value.screenshotDataUrl.startsWith('data:image/')
        ? value.screenshotDataUrl
        : null,
  }
}
