// ESLint runs one rule only, Marmot's own `marmot/no-literal-jsx-text` (`pnpm lint:i18n`). Biome does
// all other formatting and linting (biome.jsonc).
import tsParser from '@typescript-eslint/parser'
import { defineConfig, globalIgnores } from 'eslint/config'

import noLiteralJsxText from './eslint-rules/no-literal-jsx-text.mjs'

export default defineConfig([
  globalIgnores([
    '.next/**',
    'dist/**',
    'action/dist/**',
    'node_modules/**',
    'src/payload-types.ts',
    'src/app/(payload)/admin/importMap.js',
    'src/migrations/**',
    'playwright-report/**',
    'test-results/**',
    'data/**',
  ]),
  {
    // User-facing text goes through next-intl (docs/Development.md → Localisation).
    files: ['src/app/**/*.tsx', 'src/components/**/*.tsx'],
    ignores: ['src/app/(payload)/**', 'src/components/ui/**', '**/*.test.tsx'],
    languageOptions: { parser: tsParser },
    plugins: { marmot: { rules: { 'no-literal-jsx-text': noLiteralJsxText } } },
    rules: {
      // Product name, key caps and the font specimen are the same in every language.
      'marmot/no-literal-jsx-text': ['error', { allow: ['Marmot', 'G', 'Aa'] }],
    },
  },
])
