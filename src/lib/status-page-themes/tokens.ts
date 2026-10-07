/**
 * The documented set of theme tokens a status page can set, and the CSS variables of
 * `src/app/(frontend)/styles.css` each one drives. Keep this list short and stable: it is the
 * public contract for presets and per-page overrides (docs/Status-Pages.md → Themes).
 */

export const THEME_COLOR_TOKENS = [
  'background',
  'foreground',
  'card',
  'primary',
  'primaryForeground',
  'muted',
  'mutedForeground',
  'border',
  'success',
  'warning',
  'info',
  'destructive',
  'chart1',
  'chart2',
  'chart3',
  'chart4',
  'chart5',
] as const

export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number]

export const THEME_MODES = ['light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

/** Colour tokens of one mode. */
export type ThemeColors = Partial<Record<ThemeColorToken, string>>

/** CSS custom properties written for each token. */
export const TOKEN_CSS_VARIABLES: Record<ThemeColorToken, readonly string[]> = {
  background: ['--background'],
  foreground: [
    '--foreground',
    '--card-foreground',
    '--popover-foreground',
    '--secondary-foreground',
    '--accent-foreground',
  ],
  card: ['--card', '--popover'],
  primary: ['--primary', '--ring'],
  primaryForeground: ['--primary-foreground'],
  muted: ['--muted', '--secondary', '--accent'],
  mutedForeground: ['--muted-foreground'],
  border: ['--border', '--input'],
  // Status colours: "up", "warning" (pending and degraded), "maintenance" and "down".
  success: ['--status-up', '--status-up-text'],
  warning: [
    '--status-pending',
    '--status-pending-text',
    '--status-degraded',
    '--status-degraded-text',
  ],
  info: ['--status-maintenance', '--status-maintenance-text'],
  destructive: ['--status-down', '--status-down-text', '--destructive'],
  chart1: ['--chart-1'],
  chart2: ['--chart-2'],
  chart3: ['--chart-3'],
  chart4: ['--chart-4'],
  chart5: ['--chart-5'],
}

/** Corner radius: `0`–`2rem` or `0`–`32px`. */
export const RADIUS_PATTERN = /^(?:0|(?:\d{1,2}(?:\.\d{1,3})?|\.\d{1,3})(?:rem|px))$/

export function isValidRadius(value: unknown): value is string {
  if (typeof value !== 'string' || !RADIUS_PATTERN.test(value)) return false
  const n = Number.parseFloat(value)
  return value.endsWith('px') ? n <= 32 : n <= 2
}

/** Per-page overrides as stored in `status-pages.themeOverrides`. */
export interface ThemeOverrides {
  light?: ThemeColors
  dark?: ThemeColors
  radius?: string
}

export interface ThemePreset {
  /** Stable id stored on the page; never rename one that shipped. */
  id: string
  /** Display name (proper noun, not translated). */
  name: string
  light: Required<ThemeColors>
  dark: Required<ThemeColors>
  radius: string
}
