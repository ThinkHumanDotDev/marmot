/**
 * Status page themes: built-in presets plus validated per-page colour overrides, rendered as CSS
 * custom properties (never as free-form CSS). Shared by the collection (validation), the public page
 * (CSS generation) and the editor (preview, client-side validation). Pure TypeScript, no server deps.
 */
import { isValidColor, normalizeColor } from './colors'
import { THEME_PRESETS } from './presets'
import {
  isValidRadius,
  THEME_COLOR_TOKENS,
  THEME_MODES,
  TOKEN_CSS_VARIABLES,
  type ThemeColors,
  type ThemeColorToken,
  type ThemeMode,
  type ThemeOverrides,
  type ThemePreset,
} from './tokens'

export * from './colors'
export * from './tokens'
export { THEME_PRESETS }

export const DEFAULT_THEME_PRESET = 'default'

export const THEME_PRESET_IDS: readonly string[] = THEME_PRESETS.map((p) => p.id)

export const isThemePresetId = (id: unknown): id is string =>
  typeof id === 'string' && THEME_PRESET_IDS.includes(id)

/** The preset with `id`; unknown or missing ids fall back to the default preset. */
export function getThemePreset(id: string | null | undefined): ThemePreset {
  return THEME_PRESETS.find((p) => p.id === id) ?? THEME_PRESETS[0]
}

const TOKEN_SET = new Set<string>(THEME_COLOR_TOKENS)
export const isThemeColorToken = (key: string): key is ThemeColorToken => TOKEN_SET.has(key)

export type ThemeOverrideErrorCode = 'shape' | 'unknownKey' | 'invalidColor' | 'invalidRadius'

export interface ThemeOverrideError {
  /** `dark.primary`, `radius`, `light`, or `` for the whole value. */
  path: string
  code: ThemeOverrideErrorCode
}

export type ParsedThemeOverrides =
  { ok: true; value: ThemeOverrides | null } | { ok: false; errors: ThemeOverrideError[] }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const isEmpty = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '')

/**
 * Validates and normalises `themeOverrides`. Empty values are dropped (they mean "use the preset"),
 * unknown keys and anything that is not an accepted colour/radius are errors. Returns `null` when
 * nothing is overridden so untouched pages keep a `null` column.
 */
export function parseThemeOverrides(input: unknown): ParsedThemeOverrides {
  if (isEmpty(input)) return { ok: true, value: null }
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: '', code: 'shape' }] }

  const errors: ThemeOverrideError[] = []
  const out: ThemeOverrides = {}

  for (const [key, value] of Object.entries(input)) {
    if (key === 'radius') {
      if (isEmpty(value)) continue
      const radius = typeof value === 'string' ? value.trim().toLowerCase() : value
      if (isValidRadius(radius)) out.radius = radius
      else errors.push({ path: 'radius', code: 'invalidRadius' })
      continue
    }
    if (!(THEME_MODES as readonly string[]).includes(key)) {
      errors.push({ path: key, code: 'unknownKey' })
      continue
    }
    const mode = key as ThemeMode
    if (isEmpty(value)) continue
    if (!isPlainObject(value)) {
      errors.push({ path: mode, code: 'shape' })
      continue
    }
    const colors: ThemeColors = {}
    for (const [token, color] of Object.entries(value)) {
      if (!isThemeColorToken(token)) {
        errors.push({ path: `${mode}.${token}`, code: 'unknownKey' })
        continue
      }
      if (isEmpty(color)) continue
      if (typeof color !== 'string' || !isValidColor(color)) {
        errors.push({ path: `${mode}.${token}`, code: 'invalidColor' })
        continue
      }
      colors[token] = normalizeColor(color)
    }
    if (Object.keys(colors).length > 0) out[mode] = colors
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: Object.keys(out).length > 0 ? out : null }
}

/** English message for API / admin validation errors (the editor translates the codes itself). */
export function describeThemeOverrideError({ path, code }: ThemeOverrideError): string {
  switch (code) {
    case 'invalidColor':
      return `${path}: use a hex (#rrggbb), rgb(), hsl() or oklch() colour.`
    case 'invalidRadius':
      return 'radius: use 0, up to 2rem, or up to 32px.'
    case 'unknownKey':
      return `${path}: unknown theme token.`
    default:
      return `${path || 'themeOverrides'}: expected { light, dark, radius }.`
  }
}

/** Effective colours of one mode: the preset's tokens with the page's overrides on top. */
export function resolveThemeColors(
  presetId: string | null | undefined,
  overrides: ThemeOverrides | null | undefined,
  mode: ThemeMode,
): Required<ThemeColors> {
  return { ...getThemePreset(presetId)[mode], ...validColors(overrides?.[mode]) }
}

export function resolveThemeRadius(
  presetId: string | null | undefined,
  overrides: ThemeOverrides | null | undefined,
): string {
  return overrides?.radius && isValidRadius(overrides.radius)
    ? overrides.radius
    : getThemePreset(presetId).radius
}

/** Drops anything that is not an accepted token/colour pair (defence in depth at render time). */
function validColors(colors: ThemeColors | null | undefined): ThemeColors {
  const out: ThemeColors = {}
  if (!colors || typeof colors !== 'object') return out
  for (const [token, color] of Object.entries(colors)) {
    if (isThemeColorToken(token) && isValidColor(color)) out[token] = normalizeColor(color!)
  }
  return out
}

/** `{ '--primary': '#0b5cad', '--ring': '#0b5cad', … }` for a set of tokens. */
export function themeVariables(colors: ThemeColors, radius?: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const [token, color] of Object.entries(validColors(colors))) {
    for (const name of TOKEN_CSS_VARIABLES[token as ThemeColorToken]) vars[name] = color
  }
  if (radius && isValidRadius(radius)) vars['--radius'] = radius
  return vars
}

const declarations = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([name, value]) => `${name}:${value}`)
    .join(';')

/**
 * The page's theme as a stylesheet of CSS custom properties, or `''` when the page uses the default
 * preset without overrides (existing pages render exactly as before). Light tokens target
 * `html:not(.dark)`, dark tokens `html.dark`, so a light override never leaks into dark mode.
 * Every value is re-validated here, so nothing but known variables and grammar-checked colours can
 * reach the `<style>` tag.
 */
export function buildThemeCss(
  presetId: string | null | undefined,
  overrides: ThemeOverrides | null | undefined,
): string {
  const preset = getThemePreset(presetId)
  const isDefault = preset.id === DEFAULT_THEME_PRESET
  const rules: string[] = []

  for (const mode of THEME_MODES) {
    const colors = { ...(isDefault ? {} : preset[mode]), ...validColors(overrides?.[mode]) }
    const vars = themeVariables(colors)
    if (Object.keys(vars).length > 0) {
      rules.push(`${mode === 'dark' ? 'html.dark' : 'html:not(.dark)'}{${declarations(vars)}}`)
    }
  }

  const radius = overrides?.radius && isValidRadius(overrides.radius) ? overrides.radius : null
  const effectiveRadius = radius ?? (isDefault ? null : preset.radius)
  if (effectiveRadius) rules.push(`html:root{--radius:${effectiveRadius}}`)

  return rules.join('\n')
}
