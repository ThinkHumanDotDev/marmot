/** Fixed categorical colour of the n-th check location (#92), by assignment order. */
export const LOCATION_SERIES_COLORS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
] as const

/** Colour of the location at `index`; locations past the eighth share a neutral grey. */
export const locationColor = (index: number): string =>
  LOCATION_SERIES_COLORS[index] ?? 'var(--muted-foreground)'
