import type { Theme } from '@c15t/nextjs'

/**
 * Maps c15t's design tokens onto Marmot's theme variables (`src/app/(frontend)/styles.css`) so the
 * banner and dialog look like the rest of the UI (shadcn surfaces, ember accent, Inter) and follow
 * dark mode automatically: the values are `var()` references that resolve against `.dark`.
 */
export const consentTheme = {
  colors: {
    primary: 'var(--primary)',
    primaryHover: 'color-mix(in oklab, var(--primary) 90%, black)',
    surface: 'var(--popover)',
    surfaceHover: 'var(--muted)',
    border: 'var(--border)',
    borderHover: 'var(--input)',
    text: 'var(--popover-foreground)',
    textMuted: 'var(--muted-foreground)',
    textOnPrimary: 'var(--primary-foreground)',
    overlay: 'rgb(0 0 0 / 0.5)',
    switchTrack: 'var(--input)',
    switchTrackActive: 'var(--primary)',
    switchThumb: 'var(--background)',
  },
  typography: {
    fontFamily:
      'var(--font-inter), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: { sm: '0.8125rem', base: '0.875rem', lg: '1rem' },
    fontWeight: { normal: 400, medium: 500, semibold: 600 },
  },
  radius: {
    sm: 'calc(var(--radius) - 4px)',
    md: 'calc(var(--radius) - 2px)',
    lg: 'var(--radius)',
    full: '9999px',
  },
  shadows: {
    sm: '0 1px 2px rgb(0 0 0 / 0.05)',
    md: '0 4px 12px rgb(0 0 0 / 0.08)',
    lg: '0 8px 24px rgb(0 0 0 / 0.12)',
  },
  consentActions: {
    default: { mode: 'stroke' },
    accept: { variant: 'primary', mode: 'filled' },
    customize: { variant: 'neutral', mode: 'ghost' },
  },
} satisfies Theme
