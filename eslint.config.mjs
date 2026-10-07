import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import prettier from 'eslint-config-prettier'
import { defineConfig, globalIgnores } from 'eslint/config'

import noLiteralJsxText from './eslint-rules/no-literal-jsx-text.mjs'

export default defineConfig([
  globalIgnores([
    '.next/**',
    'dist/**',
    'node_modules/**',
    'src/payload-types.ts',
    'src/payload-generated-schema.ts',
    'src/app/(payload)/admin/importMap.js',
    'src/migrations/**',
    'playwright-report/**',
    'test-results/**',
    'data/**',
  ]),
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    rules: {
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          args: 'after-used',
          ignoreRestSiblings: false,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^(_|ignore)',
        },
      ],
    },
  },
  {
    // User-facing text goes through next-intl (docs/Development.md → Localisation).
    files: ['src/app/**/*.tsx', 'src/components/**/*.tsx'],
    ignores: ['src/app/(payload)/**', 'src/components/ui/**', '**/*.test.tsx'],
    plugins: { marmot: { rules: { 'no-literal-jsx-text': noLiteralJsxText } } },
    rules: { 'marmot/no-literal-jsx-text': 'error' },
  },
])
