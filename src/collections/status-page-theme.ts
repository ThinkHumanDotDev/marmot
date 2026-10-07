/**
 * Theme fields of `status-pages` (preset, colour overrides, banner, dark logo, favicon). Kept apart
 * from `StatusPages.ts` so the theming contract lives next to its validation. Colours are validated
 * against a closed grammar (`src/lib/status-page-themes`) and rendered as CSS variables only.
 */
import type { Field, FieldHook } from 'payload'

import { adminT } from '@/i18n/admin'
import {
  DEFAULT_THEME_PRESET,
  describeThemeOverrideError,
  isThemePresetId,
  parseThemeOverrides,
  THEME_COLOR_TOKENS,
  THEME_PRESET_IDS,
} from '@/lib/status-page-themes'

export const BANNER_TEXT_MAX_LENGTH = 140

/** Normalises overrides (trimmed, lower-case, empty values dropped) before validation. */
const normalizeOverrides: FieldHook = ({ value }) => {
  const parsed = parseThemeOverrides(value)
  return parsed.ok ? parsed.value : value
}

const colorsSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: Object.fromEntries(
    THEME_COLOR_TOKENS.map((token) => [token, { type: 'string' as const }]),
  ),
}

export const statusPageThemeFields: Field[] = [
  {
    name: 'themePreset',
    type: 'text',
    defaultValue: DEFAULT_THEME_PRESET,
    // Plain text (not a select) so contributors can add presets without a migration.
    validate: (value: unknown) =>
      value == null || value === '' || isThemePresetId(value)
        ? true
        : `Unknown theme preset. Use one of: ${THEME_PRESET_IDS.join(', ')}.`,
    admin: { description: adminT('marmot:statusPages:themePresetDescription') },
  },
  {
    name: 'themeOverrides',
    type: 'json',
    hooks: { beforeValidate: [normalizeOverrides] },
    validate: (value: unknown) => {
      const parsed = parseThemeOverrides(value)
      return parsed.ok ? true : parsed.errors.map(describeThemeOverrideError).join(' ')
    },
    typescriptSchema: [
      () => ({
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          light: colorsSchema,
          dark: colorsSchema,
          radius: { type: 'string' },
        },
      }),
    ],
    admin: { description: adminT('marmot:statusPages:themeOverridesDescription') },
  },
  {
    name: 'bannerText',
    type: 'text',
    maxLength: BANNER_TEXT_MAX_LENGTH,
    admin: { description: adminT('marmot:statusPages:bannerTextDescription') },
  },
  {
    type: 'row',
    fields: [
      {
        name: 'logoDark',
        type: 'upload',
        relationTo: 'media',
        admin: { description: adminT('marmot:statusPages:logoDarkDescription') },
      },
      {
        name: 'favicon',
        type: 'upload',
        relationTo: 'media',
        admin: { description: adminT('marmot:statusPages:faviconDescription') },
      },
    ],
  },
]
