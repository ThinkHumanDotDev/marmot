import { describe, expect, it } from 'vitest'

import {
  httpSuiteProblems,
  httpSuiteSchema,
  parseSuiteStepResults,
  suiteReferences,
  suiteTargetUrls,
  type HttpSuite,
} from './http-suite'
import { defaultMonitorValues } from './monitor'
import { monitorFormSchema } from './monitor-schema'

const parse = (input: unknown) => httpSuiteSchema.parse(input) as HttpSuite

describe('http-suite definition', () => {
  it('accepts maps for vars, secrets, headers and store and normalises them to rows', () => {
    const suite = parse({
      vars: { base: 'https://api.test', retries: 3 },
      secrets: { password: 'pw' },
      steps: [
        {
          key: 'login',
          method: 'post',
          url: '{{ vars.base }}/login',
          headers: { 'X-Client': 'marmot' },
          store: { token: '$.token', session: { from: 'header:set-cookie', secret: true } },
          acceptedStatusCodes: '200, 201',
        },
      ],
    })
    expect(suite.vars).toEqual([
      { name: 'base', value: 'https://api.test' },
      { name: 'retries', value: '3' },
    ])
    expect(suite.steps[0]).toMatchObject({
      method: 'POST',
      headers: [{ name: 'X-Client', value: 'marmot' }],
      store: [
        { name: 'token', from: '$.token', secret: false },
        { name: 'session', from: 'header:set-cookie', secret: true },
      ],
      acceptedStatusCodes: ['200', '201'],
      alwaysRun: false,
      authMethod: 'none',
    })
    // The row form parses to the same value (what exports write back).
    expect(parse(suite)).toEqual(suite)
  })

  it('finds placeholders', () => {
    expect(
      suiteReferences('{{vars.a}}/{{ steps.login.token }}?k={{ secrets.key }}').map((r) => r.raw),
    ).toEqual(['{{vars.a}}', '{{ steps.login.token }}', '{{ secrets.key }}'])
  })

  it('only lets a step use values defined before it', () => {
    const suite = parse({
      vars: { base: 'https://api.test' },
      steps: [
        { key: 'a', url: '{{ vars.base }}/a', headers: { Authorization: '{{ steps.b.token }}' } },
        { key: 'b', url: '{{ vars.base }}/b', store: { token: '$.t' } },
        { key: 'c', url: '{{ vars.base }}/{{ vars.token }}?s={{ secrets.nope }}' },
      ],
    })
    expect(httpSuiteProblems(suite)).toEqual([
      {
        path: ['steps', 0, 'headers', 0, 'value'],
        key: 'suiteUnknownReference',
        values: { name: 'steps.b.token' },
      },
      {
        path: ['steps', 2, 'url'],
        key: 'suiteUnknownReference',
        values: { name: 'secrets.nope' },
      },
    ])
  })

  it('checks keys, names, URLs, status codes and assertions', () => {
    const problems = httpSuiteProblems(
      parse({
        vars: [{ name: '1bad', value: 'x' }],
        steps: [
          { key: 'a', url: 'ftp://x', acceptedStatusCodes: ['299-200'] },
          {
            key: 'a',
            url: 'https://x.test',
            assertions: [{ kind: 'dnsRecord', comparator: 'eq', value: 'x' }],
            store: [{ name: 't', from: '' }],
          },
        ],
      }),
    )
    expect(problems.map((p) => [p.path.join('.'), p.key])).toEqual([
      ['vars.0.name', 'suiteName'],
      ['steps.0.url', 'suiteUrl'],
      ['steps.0.acceptedStatusCodes', 'suiteStatusCodes'],
      ['steps.1.key', 'suiteStepKeyDuplicate'],
      ['steps.1.assertions.0.kind', 'assertionKind'],
      ['steps.1.store.0.from', 'suiteStoreFrom'],
    ])
    expect(httpSuiteProblems(parse({ steps: [] }))).toEqual([
      { path: ['steps'], key: 'suiteStepsRequired' },
    ])
  })

  it('is validated by the monitor form schema for http-suite monitors only', () => {
    const base = { ...defaultMonitorValues('http-suite'), name: 'Suite' }
    const missing = monitorFormSchema.safeParse(base)
    expect(missing.success).toBe(false)
    expect(missing.error?.issues[0]?.path).toEqual(['httpSuite', 'steps'])

    const valid = monitorFormSchema.safeParse({
      ...base,
      httpSuite: { steps: [{ key: 'health', url: 'https://api.test/health' }] },
    })
    expect(valid.success).toBe(true)
    expect(valid.data?.httpSuite?.steps[0]?.acceptedStatusCodes).toEqual(['200-299'])

    expect(
      monitorFormSchema.safeParse({
        ...defaultMonitorValues('http'),
        name: 'Plain',
        url: 'https://x.test',
      }).data?.httpSuite,
    ).toBeNull()
  })

  it('lists the target URLs it can know before running', () => {
    expect(
      suiteTargetUrls({
        vars: { base: 'https://api.test' },
        steps: [
          { key: 'a', url: '{{ vars.base }}/a' },
          { key: 'b', url: 'https://other.test/b', store: { host: '$.h' } },
          { key: 'c', url: 'https://{{ steps.b.host }}/c' },
        ],
      }),
    ).toEqual(['https://api.test/a', 'https://other.test/b'])
  })

  it('reads stored step results and drops malformed rows', () => {
    expect(
      parseSuiteStepResults([
        { key: 'a', outcome: 'passed', statusCode: 200, start: 0, duration: 12, msg: 'ok' },
        { key: 'b', outcome: 'weird' },
        null,
      ]),
    ).toMatchObject([{ key: 'a', name: 'a', outcome: 'passed', statusCode: 200, duration: 12 }])
  })
})
