/**
 * Sandboxed LiquidJS rendering for notification message templates (#150).
 *
 * Templates are written by organization members and rendered in the worker, so the engine is
 * locked down:
 *
 * - no file system: `include`, `render`, `layout` and `block` are not registered, and the engine
 *   resolves partials from an empty in-memory map, so no template can read a file;
 * - only the variables Marmot hands it (plain data, `ownPropertyOnly`), never `process`, `env` or
 *   prototypes;
 * - an allow-list of filters (`ALLOWED_FILTERS`) with unknown filters as errors (`strictFilters`);
 * - limits: template length (`TEMPLATE_MAX_LENGTH`), render time (`TEMPLATE_RENDER_LIMIT_MS`),
 *   allocations (`memoryLimit`) and output size (`TEMPLATE_MAX_OUTPUT`).
 *
 * Plain `{{ path }}` templates render exactly as with the earlier placeholder renderer: unknown
 * variables are empty and objects print as JSON. In `html` mode every output is HTML-escaped
 * (opt out per value with `| raw`).
 */
import { Liquid, type FilterImplOptions } from 'liquidjs'

import { defaultLocale, type Locale } from '@/i18n/locales'
import { escapeHtml } from '@/lib/markdown'
import { unknownTemplateVariable } from '@/lib/notification-template-variables'
import { humanDuration } from '@/lib/validation/monitor'
import { serverTranslator } from '@/server/i18n'

/** Longest template accepted (characters). */
export const TEMPLATE_MAX_LENGTH = 20_000
/** Longest a render may take before it is aborted (milliseconds). */
export const TEMPLATE_RENDER_LIMIT_MS = 200
/** Longest output a template may produce (characters). */
export const TEMPLATE_MAX_OUTPUT = 100_000
/** Allocation budget of one render (LiquidJS units: array items, string lengths). */
const TEMPLATE_MEMORY_LIMIT = 2_000_000

/** `text` prints values as they are; `html` escapes every output (`| raw` opts out). */
export type TemplateMode = 'text' | 'html'

/** Why a template cannot be used. `detail` is LiquidJS's (English) explanation. */
export type TemplateErrorCode =
  'syntax' | 'render' | 'tooLong' | 'outputTooLong' | 'unknownVariable'

export class TemplateError extends Error {
  readonly code: TemplateErrorCode
  readonly detail: string
  constructor(code: TemplateErrorCode, detail: string) {
    super(`Template ${code}: ${detail}`)
    this.name = 'TemplateError'
    this.code = code
    this.detail = detail
  }
}

/** Tags templates may use. Everything that loads other templates is missing on purpose. */
const ALLOWED_TAGS = new Set([
  'assign',
  'capture',
  'case',
  'comment',
  '#',
  'if',
  'unless',
  'for',
  'break',
  'continue',
  'cycle',
  'increment',
  'decrement',
  'echo',
  'liquid',
  'raw',
  'tablerow',
])

/**
 * Filters templates may use: pure string, list and number helpers from LiquidJS, its `date`
 * (in the organization's time zone and language) and `json`, plus Marmot's `duration`.
 */
export const ALLOWED_FILTERS = [
  // text
  'append',
  'prepend',
  'capitalize',
  'downcase',
  'upcase',
  'strip',
  'lstrip',
  'rstrip',
  'strip_newlines',
  'strip_html',
  'newline_to_br',
  'replace',
  'replace_first',
  'replace_last',
  'remove',
  'remove_first',
  'remove_last',
  'truncate',
  'truncatewords',
  'split',
  'slice',
  'size',
  'default',
  'escape',
  'escape_once',
  'url_encode',
  'url_decode',
  'normalize_whitespace',
  'raw',
  // lists
  'join',
  'first',
  'last',
  'map',
  'where',
  'reject',
  'sort',
  'sort_natural',
  'uniq',
  'compact',
  'reverse',
  'concat',
  'sum',
  // numbers
  'abs',
  'at_least',
  'at_most',
  'ceil',
  'floor',
  'round',
  'plus',
  'minus',
  'times',
  'divided_by',
  'modulo',
  // data
  'date',
  'json',
  'jsonify',
  'duration',
] as const

const stringify = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return String(value)
}

/** `{{ downtimeSeconds | duration }}` → `7 minutes 3 seconds` in the organization's language. */
const durationFilter = (locale: Locale): FilterImplOptions =>
  function duration(value: unknown) {
    const seconds = typeof value === 'number' ? value : Number(String(value ?? '').trim())
    if (value === '' || value === null || value === undefined || !Number.isFinite(seconds)) {
      return value
    }
    const t = serverTranslator(locale)
    return humanDuration(Math.max(0, Math.round(seconds)), (unit, count) =>
      t(`common.duration.${unit}`, { count }),
    )
  }

const engines = new Map<string, Liquid>()

/** The engine for `mode`, `locale` and `timeZone`, built once per combination. */
function engineFor(mode: TemplateMode, locale: Locale, timeZone: string): Liquid {
  const key = `${mode}|${locale}|${timeZone}`
  const cached = engines.get(key)
  if (cached) return cached
  const engine = new Liquid({
    // No partials, layouts or file lookups: an empty in-memory map replaces the file system.
    templates: {},
    relativeReference: false,
    dynamicPartials: false,
    ownPropertyOnly: true,
    strictFilters: true,
    strictVariables: false,
    jsTruthy: false,
    cache: false,
    timezoneOffset: timeZone,
    locale,
    parseLimit: TEMPLATE_MAX_LENGTH,
    renderLimit: TEMPLATE_RENDER_LIMIT_MS,
    memoryLimit: TEMPLATE_MEMORY_LIMIT,
    outputEscape:
      mode === 'html'
        ? (value: unknown) => escapeHtml(stringify(value))
        : (value) => stringify(value),
  })
  for (const tag of Object.keys(engine.tags)) {
    if (!ALLOWED_TAGS.has(tag)) delete engine.tags[tag]
  }
  engine.registerFilter('duration', durationFilter(locale))
  if (mode === 'html') {
    // An explicit `| escape` is the escaping in HTML mode, not a second pass over it.
    for (const name of ['escape', 'escape_once'] as const) {
      const builtin = engine.filters[name]
      const handler = typeof builtin === 'function' ? builtin : builtin.handler
      engine.registerFilter(name, { handler, raw: true })
    }
  }
  const allowed = new Set<string>(ALLOWED_FILTERS)
  for (const filter of Object.keys(engine.filters)) {
    if (!allowed.has(filter)) engine.unregisterFilter(filter)
  }
  engines.set(key, engine)
  return engine
}

export interface RenderLiquidOptions {
  mode?: TemplateMode
  locale?: Locale
  /** IANA zone for the `date` filter (the organization's); UTC by default. */
  timeZone?: string
}

const liquidMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Parse `template` (syntax, tags, filters, length) or throw `TemplateError`. */
function parse(engine: Liquid, template: string) {
  if (template.length > TEMPLATE_MAX_LENGTH) {
    throw new TemplateError('tooLong', `longer than ${TEMPLATE_MAX_LENGTH} characters`)
  }
  try {
    return engine.parse(template)
  } catch (error) {
    throw new TemplateError('syntax', liquidMessage(error))
  }
}

/**
 * Render `template` against `context`. Throws `TemplateError` for invalid templates, renders that
 * hit a limit and outputs over `TEMPLATE_MAX_OUTPUT`.
 */
export function renderLiquid(
  template: string,
  context: object,
  { mode = 'text', locale = defaultLocale, timeZone = 'UTC' }: RenderLiquidOptions = {},
): string {
  const engine = engineFor(mode, locale, timeZone)
  const parsed = parse(engine, template)
  let output: unknown
  try {
    output = engine.renderSync(parsed, context)
  } catch (error) {
    throw new TemplateError('render', liquidMessage(error))
  }
  const text = typeof output === 'string' ? output : stringify(output)
  if (text.length > TEMPLATE_MAX_OUTPUT) {
    throw new TemplateError('outputTooLong', `longer than ${TEMPLATE_MAX_OUTPUT} characters`)
  }
  return text
}

/**
 * Check a template without rendering it: syntax, allowed tags and filters, length, and that every
 * variable it reads exists (`TEMPLATE_VARIABLES`). Throws `TemplateError` for the first problem.
 */
export function validateTemplate(template: string): void {
  const engine = engineFor('text', defaultLocale, 'UTC')
  const parsed = parse(engine, template)
  let references: ReturnType<Liquid['globalVariableSegmentsSync']>
  try {
    references = engine.globalVariableSegmentsSync(parsed)
  } catch (error) {
    throw new TemplateError('syntax', liquidMessage(error))
  }
  for (const segments of references) {
    const unknown = unknownTemplateVariable(segments)
    if (unknown) throw new TemplateError('unknownVariable', unknown)
  }
}
