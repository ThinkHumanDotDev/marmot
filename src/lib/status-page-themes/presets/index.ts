/**
 * Built-in status page theme presets. To add one, create a file next to these that exports a
 * `ThemePreset` and append it below. The id is stored as plain text, so no migration is needed. `src/lib/status-page-themes/themes.test.ts` checks every preset for
 * complete tokens and WCAG contrast.
 */
import type { ThemePreset } from '../tokens'
import { defaultPreset } from './default'
import { forestPreset } from './forest'
import { graphitePreset } from './graphite'
import { highContrastPreset } from './high-contrast'
import { oceanPreset } from './ocean'

export const THEME_PRESETS: readonly ThemePreset[] = [
  defaultPreset,
  highContrastPreset,
  oceanPreset,
  forestPreset,
  graphitePreset,
]
