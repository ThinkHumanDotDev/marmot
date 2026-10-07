import type { ThemePreset } from '../tokens'

/**
 * Marmot's own palette, mirroring `src/app/(frontend)/styles.css`. Pages on this preset get no
 * generated CSS at all (the stylesheet already applies it); the values here feed the editor's
 * preview and swatches. Keep them in sync with the stylesheet.
 */
export const defaultPreset: ThemePreset = {
  id: 'default',
  name: 'Marmot',
  radius: '0.75rem',
  light: {
    background: 'oklch(0.995 0.003 85)',
    foreground: 'oklch(0.2 0.012 60)',
    card: 'oklch(1 0 0)',
    primary: 'oklch(0.56 0.18 40)',
    primaryForeground: 'oklch(0.99 0.01 80)',
    muted: 'oklch(0.955 0.008 80)',
    mutedForeground: 'oklch(0.5 0.015 65)',
    border: 'oklch(0.9 0.01 80)',
    success: 'oklch(0.62 0.16 150)',
    warning: 'oklch(0.78 0.16 80)',
    info: 'oklch(0.62 0.14 250)',
    destructive: 'oklch(0.6 0.21 27)',
    chart1: 'oklch(0.64 0.19 42)',
    chart2: 'oklch(0.72 0.15 55)',
    chart3: 'oklch(0.8 0.1 70)',
    chart4: 'oklch(0.55 0.15 35)',
    chart5: 'oklch(0.45 0.1 30)',
  },
  dark: {
    background: 'oklch(0.2 0.008 60)',
    foreground: 'oklch(0.95 0.008 80)',
    card: 'oklch(0.235 0.008 60)',
    primary: 'oklch(0.72 0.17 45)',
    primaryForeground: 'oklch(0.16 0.02 40)',
    muted: 'oklch(0.28 0.008 60)',
    mutedForeground: 'oklch(0.68 0.012 75)',
    border: 'oklch(1 0 0 / 10%)',
    success: 'oklch(0.74 0.16 150)',
    warning: 'oklch(0.82 0.15 85)',
    info: 'oklch(0.7 0.12 250)',
    destructive: 'oklch(0.68 0.19 25)',
    chart1: 'oklch(0.72 0.17 45)',
    chart2: 'oklch(0.78 0.13 60)',
    chart3: 'oklch(0.84 0.09 75)',
    chart4: 'oklch(0.6 0.14 35)',
    chart5: 'oklch(0.5 0.1 30)',
  },
}
