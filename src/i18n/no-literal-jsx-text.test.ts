import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

import rule, { isTechnical } from '../../eslint-rules/no-literal-jsx-text.mjs'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
})

tester.run('no-literal-jsx-text', rule, {
  valid: [
    'const a = <p>{t("save")}</p>',
    'const a = <p>{count} · {total}</p>',
    'const a = <Input placeholder="https://example.com/health" />',
    'const a = <Input placeholder="my-node" />',
    'const a = <Input placeholder={\'{ "key": "value" }\'} />',
    'const a = <span>/status/{slug}</span>',
    'const a = <code>docker compose up -d</code>',
    'const a = <kbd>⌘K</kbd>',
    'const a = <p className="Not checked" data-label="Not checked">{x}</p>',
    { code: 'const a = <span>Marmot</span>', options: [{ allow: ['Marmot'] }] },
  ],
  invalid: [
    { code: 'const a = <p>Save changes</p>', errors: [{ messageId: 'literal' }] },
    { code: 'const a = <p>{"Save"}</p>', errors: [{ messageId: 'literal' }] },
    { code: 'const a = <p>{busy ? "Saving…" : t("save")}</p>', errors: [{ messageId: 'literal' }] },
    {
      code: 'const a = <Input placeholder="Search monitors" />',
      errors: [{ messageId: 'literal' }],
    },
    { code: 'const a = <img alt={`Logo of ${name}`} />', errors: [{ messageId: 'literal' }] },
    { code: 'const a = <Button aria-label="Close" />', errors: [{ messageId: 'literal' }] },
    {
      code: 'const a = <p>{name} offers several ways to sign in:</p>',
      errors: [{ messageId: 'literal' }],
    },
  ],
})

describe('isTechnical', () => {
  it('tells technical values from prose', ({ expect }) => {
    expect(isTechnical('api.example.com:443')).toBe(true)
    expect(isTechnical('kafka1:9092 kafka2:9092')).toBe(true)
    expect(isTechnical('-----BEGIN CERTIFICATE-----')).toBe(true)
    expect(isTechnical('G-XXXXXXXXXX')).toBe(true)
    expect(isTechnical('Continue')).toBe(false)
    expect(isTechnical('Continue.')).toBe(false)
    expect(isTechnical('Work email')).toBe(false)
  })
})
