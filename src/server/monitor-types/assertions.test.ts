import { describe, expect, it } from 'vitest'

import {
  assertionProblems,
  normalizeAssertions,
  type AssertionComparator,
  type MonitorAssertion,
} from '@/lib/validation/assertions'

import {
  compareValue,
  describeAssertionResult,
  dnsRecordStrings,
  evaluateDnsAssertions,
  evaluateHttpAssertions,
  evaluateJsonata,
  headerValue,
  passedSuffix,
  safeRegexTest,
  SafeRegExp,
} from './assertions'

const response = {
  statusCode: 200,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=60',
    'set-cookie': ['a=1', 'b=2'],
    'x-empty': '',
  },
  body: JSON.stringify({
    status: 'ok',
    version: '1.4.2',
    data: { count: 3, items: [{ id: 1 }, { id: 2 }], flags: [] },
    healthy: true,
  }),
}

const a = (
  kind: MonitorAssertion['kind'],
  comparator: AssertionComparator,
  value: string | null = null,
  target: string | null = null,
): MonitorAssertion => ({ kind, comparator, value, target })

describe('compareValue', () => {
  const cases: [AssertionComparator, string | null, string, boolean][] = [
    ['eq', 'abc', 'abc', true],
    ['eq', 'abc', 'ABC', false],
    ['eq', null, 'abc', false],
    ['not_eq', 'abc', 'abd', true],
    ['not_eq', null, 'abc', true],
    ['contains', 'hello marmot', 'marmot', true],
    ['contains', null, 'x', false],
    ['not_contains', 'hello marmot', 'error', true],
    ['not_contains', 'an error', 'error', false],
    ['empty', '', '', true],
    ['empty', null, '', true],
    ['empty', 'x', '', false],
    ['not_empty', 'x', '', true],
    ['not_empty', null, '', false],
    ['gt', '5', '3', true],
    ['gt', '3', '3', false],
    ['gte', '3', '3', true],
    ['lt', '2.5', '3', true],
    ['lte', '4', '3', false],
    ['gt', 'abc', '3', false],
    ['gt', null, '3', false],
    ['matches', 'build 1.4.2', '\\d+\\.\\d+\\.\\d+', true],
    ['matches', 'HELLO', '/hello/i', true],
    ['matches', 'HELLO', 'hello', false],
    ['not_matches', 'ok', '^err', true],
  ]
  it.each(cases)('%s(%j, %j) → %s', (comparator, actual, expected, passed) => {
    expect(compareValue(comparator, actual, expected)).toBe(passed)
  })

  it('numeric equality only when asked for', () => {
    expect(compareValue('eq', '1.0', '1')).toBe(false)
    expect(compareValue('eq', '1.0', '1', { numericEquality: true })).toBe(true)
  })

  it('DNS names ignore case and a trailing dot', () => {
    expect(compareValue('eq', 'Mail.Example.com.', 'mail.example.com', { dnsName: true })).toBe(
      true,
    )
  })
})

describe('safe regular expressions', () => {
  it('times out catastrophic backtracking instead of blocking', () => {
    const started = Date.now()
    expect(() => safeRegexTest('^(a+)+$', `${'a'.repeat(40)}b`)).toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('cuts a catastrophic pattern off after its CPU budget', () => {
    const started = Date.now()
    expect(() =>
      safeRegexTest('^(a+)+$', `${'a'.repeat(40)}b`, { cpuMs: 20, wallMs: 1000 }),
    ).toThrow(/timed out after 20 ms/)
    // An idle host stops at the 20 ms budget; a loaded one at the 1000 ms wall cap at the latest.
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('a thread starved of CPU is retried, but never beyond the wall-clock cap', () => {
    // A frozen CPU clock looks like scheduling delay, so the match gets a second attempt...
    const starved = { cpuMs: 20, wallMs: 300, cpuClock: () => 0 }
    const started = Date.now()
    expect(() => safeRegexTest('^(a+)+$', `${'a'.repeat(40)}b`, starved)).toThrow(/timed out/)
    // ...that runs until the wall cap, not forever.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(safeRegexTest('"version":"1\\.\\d+', response.body, starved)).toBe(true)
  })

  it('rejects invalid and over-long patterns', () => {
    expect(() => safeRegexTest('(', 'x')).toThrow(/invalid/)
    expect(() => safeRegexTest('a'.repeat(501), 'x')).toThrow(/invalid/)
  })

  it('SafeRegExp behaves like a global RegExp for JSONata', async () => {
    const re = new SafeRegExp(/o/g)
    expect(re.exec('foo')?.index).toBe(1)
    expect(re.exec('foo')?.index).toBe(2)
    expect(re.exec('foo')).toBeNull()
    const matches = (await evaluateJsonata('$match("a1b22", /[0-9]+/).match', {})) as string[]
    expect([...matches]).toEqual(['1', '22'])
    expect(await evaluateJsonata('$contains(status, /^o/)', { status: 'ok' })).toBe(true)
  })

  it('a ReDoS pattern inside a JSONata expression fails instead of hanging', async () => {
    await expect(
      evaluateJsonata('$contains(s, /^(a+)+$/)', { s: `${'a'.repeat(40)}b` }),
    ).rejects.toThrow(/timed out/)
  })

  it('JSONata runaway recursion hits the depth guard', async () => {
    await expect(
      evaluateJsonata('($f := function($x){ $f($x + 1) }; $f(0))', {}),
    ).rejects.toBeDefined()
  })
})

describe('evaluateHttpAssertions', () => {
  const cases: [string, MonitorAssertion, boolean, string | null][] = [
    ['status eq', a('status', 'eq', '200'), true, '200'],
    ['status not_eq', a('status', 'not_eq', '200'), false, '200'],
    ['status lt', a('status', 'lt', '300'), true, '200'],
    ['header case-insensitive', a('header', 'contains', 'json', 'Content-Type'), true, null],
    ['header contains', a('header', 'contains', 'max-age', 'cache-control'), true, null],
    ['header missing eq', a('header', 'eq', 'x', 'x-missing'), false, null],
    ['header missing empty', a('header', 'empty', null, 'x-missing'), true, null],
    ['header empty value', a('header', 'empty', null, 'x-empty'), true, ''],
    ['header not_empty', a('header', 'not_empty', null, 'x-missing'), false, null],
    ['repeated header joined', a('header', 'eq', 'a=1, b=2', 'set-cookie'), true, 'a=1, b=2'],
    ['body contains', a('textBody', 'contains', '"status":"ok"'), true, null],
    ['body not_contains', a('textBody', 'not_contains', 'error'), true, null],
    ['body matches', a('textBody', 'matches', '"version":"1\\.\\d+'), true, null],
    ['json eq', a('jsonBody', 'eq', 'ok', 'status'), true, 'ok'],
    ['json jsonpath-style', a('jsonBody', 'eq', 'ok', '$.status'), true, 'ok'],
    ['json number gte', a('jsonBody', 'gte', '3', 'data.count'), true, '3'],
    ['json number eq', a('jsonBody', 'eq', '3.0', 'data.count'), true, '3'],
    ['json boolean', a('jsonBody', 'eq', 'true', 'healthy'), true, 'true'],
    ['json array index', a('jsonBody', 'eq', '2', 'data.items[1].id'), true, '2'],
    ['json aggregate', a('jsonBody', 'eq', '2', '$count(data.items)'), true, '2'],
    ['json empty array', a('jsonBody', 'empty', null, 'data.flags'), true, '[]'],
    ['json missing', a('jsonBody', 'not_empty', null, 'nope'), false, null],
    ['json object', a('jsonBody', 'contains', '"id":1', 'data.items[0]'), true, '{"id":1}'],
  ]
  it.each(cases)('%s', async (_name, assertion, passed, actual) => {
    const [result] = await evaluateHttpAssertions([assertion], response)
    expect(result.passed).toBe(passed)
    expect(result.error ?? null).toBeNull()
    if (actual !== null) expect(result.actual).toBe(actual)
  })

  it('an invalid JSONata expression is an error result, not a throw', async () => {
    const [result] = await evaluateHttpAssertions([a('jsonBody', 'eq', 'x', 'status[')], response)
    expect(result.passed).toBe(false)
    expect(result.error).toMatch(/invalid expression/)
  })

  it('a non-JSON body is queried as a string', async () => {
    const [result] = await evaluateHttpAssertions([a('jsonBody', 'eq', '5', '$length($)')], {
      ...response,
      body: 'hello',
    })
    expect(result.passed).toBe(true)
  })

  it('evaluates every assertion and keeps the order', async () => {
    const results = await evaluateHttpAssertions(
      [a('status', 'eq', '500'), a('textBody', 'contains', 'ok')],
      response,
    )
    expect(results.map((r) => r.passed)).toEqual([false, true])
  })

  it('stores long actual values truncated', async () => {
    const [result] = await evaluateHttpAssertions([a('textBody', 'contains', 'zzz')], {
      ...response,
      body: 'x'.repeat(5000),
    })
    expect(result.actual?.length).toBe(500)
  })
})

describe('DNS assertions', () => {
  it('formats record sets as comparable strings', () => {
    expect(dnsRecordStrings('MX', [{ exchange: 'mail.example.com', priority: 10 }])).toEqual([
      'mail.example.com',
    ])
    expect(dnsRecordStrings('TXT', [['v=spf1 ', 'include:x ~all']])).toEqual([
      'v=spf1 include:x ~all',
    ])
    expect(
      dnsRecordStrings('SRV', [{ name: 'sip.x', port: 5060, priority: 1, weight: 5 }]),
    ).toEqual(['1 5 5060 sip.x'])
    expect(dnsRecordStrings('CAA', [{ critical: 0, issue: 'letsencrypt.org' }])).toEqual([
      'issue letsencrypt.org',
    ])
    expect(dnsRecordStrings('A', ['1.2.3.4'])).toEqual(['1.2.3.4'])
  })

  const sets = new Map<string, string[] | Error>([
    ['A', ['192.0.2.1', '192.0.2.2']],
    ['MX', ['mail.example.com.']],
    ['TXT', []],
    ['AAAA', new Error('lookup failed: ESERVFAIL')],
  ])
  const cases: [string, MonitorAssertion, boolean][] = [
    ['any record equals', a('dnsRecord', 'eq', '192.0.2.2'), true],
    ['no record equals', a('dnsRecord', 'eq', '192.0.2.9'), false],
    ['not_eq: none equals', a('dnsRecord', 'not_eq', '10.0.0.1'), true],
    ['not_eq: one equals', a('dnsRecord', 'not_eq', '192.0.2.1'), false],
    ['MX equals ignoring the dot and case', a('dnsRecord', 'eq', 'MAIL.example.com', 'MX'), true],
    ['contains', a('dnsRecord', 'contains', '192.0.2.', 'A'), true],
    ['not_contains on no records', a('dnsRecord', 'not_contains', 'spf', 'TXT'), true],
    ['eq on no records', a('dnsRecord', 'eq', 'x', 'TXT'), false],
    ['matches', a('dnsRecord', 'matches', '^192\\.0\\.2\\.\\d$'), true],
    ['lookup error', a('dnsRecord', 'not_contains', 'x', 'AAAA'), false],
  ]
  it.each(cases)('%s', (_name, assertion, passed) => {
    const [result] = evaluateDnsAssertions([assertion], sets, 'A')
    expect(result.passed).toBe(passed)
  })

  it('defaults the record type to the monitor type and reports the records', () => {
    const [result] = evaluateDnsAssertions([a('dnsRecord', 'eq', '192.0.2.9')], sets, 'A')
    expect(result).toMatchObject({ target: 'A', actual: '192.0.2.1 | 192.0.2.2', passed: false })
    expect(describeAssertionResult(result)).toBe(
      'A record: expected == "192.0.2.9", got "192.0.2.1 | 192.0.2.2"',
    )
  })
})

describe('messages', () => {
  it('names the assertion with expected vs actual', async () => {
    const [header, status, body, json] = await evaluateHttpAssertions(
      [
        a('header', 'contains', 'html', 'content-type'),
        a('status', 'eq', '204'),
        a('textBody', 'empty'),
        a('jsonBody', 'gt', '5', 'data.count'),
      ],
      response,
    )
    expect(describeAssertionResult(header)).toBe(
      'header content-type: expected contains "html", got "application/json; charset=utf-8"',
    )
    expect(describeAssertionResult(status)).toBe('status code: expected == 204, got 200')
    expect(describeAssertionResult(body)).toMatch(/^body: expected empty, got "\{\\"status/)
    expect(describeAssertionResult(json)).toBe('json data.count: expected > 5, got 3')
    const [missing] = await evaluateHttpAssertions([a('header', 'eq', 'x', 'x-nope')], response)
    expect(describeAssertionResult(missing)).toBe('header x-nope: expected == "x", got (none)')
  })

  it('counts only explicit assertions in the success suffix', () => {
    const passed = { kind: 'status', target: null, comparator: 'eq', expected: '200' } as const
    expect(passedSuffix([{ ...passed, actual: '200', passed: true, legacy: true }])).toBe('')
    expect(passedSuffix([{ ...passed, actual: '200', passed: true }])).toBe(', 1 assertion passed')
  })

  it('headerValue is case-insensitive', () => {
    expect(headerValue({ 'Content-Type': 'a' }, 'content-type')).toBe('a')
  })
})

describe('assertionProblems', () => {
  const problems = (rows: Partial<MonitorAssertion>[], type = 'http') =>
    assertionProblems(rows, type).map((p) => `${p.index}:${p.field}:${p.key}`)

  it('accepts valid rows', () => {
    expect(
      problems([
        a('status', 'eq', '200'),
        a('header', 'contains', 'json', 'content-type'),
        a('textBody', 'not_contains', 'error'),
        a('jsonBody', 'gte', '1', '$.count'),
        a('textBody', 'empty'),
      ]),
    ).toEqual([])
    expect(problems([a('dnsRecord', 'eq', 'mail.example.com', 'MX')], 'dns')).toEqual([])
    expect(problems([a('dnsRecord', 'contains', '1.2.3')], 'dns')).toEqual([])
  })

  it('rejects kinds and comparators that do not fit', () => {
    expect(problems([a('dnsRecord', 'eq', 'x')], 'http')).toEqual(['0:kind:assertionKind'])
    expect(problems([a('header', 'eq', 'x', 'a')], 'dns')).toEqual(['0:kind:assertionKind'])
    expect(problems([a('status', 'contains', '2')])).toEqual(['0:comparator:assertionComparator'])
    expect(problems([a('header', 'gt', '2', 'age')])).toEqual(['0:comparator:assertionComparator'])
  })

  it('checks targets and values', () => {
    expect(problems([a('header', 'eq', 'x')])).toEqual(['0:target:assertionTargetRequired'])
    expect(problems([a('header', 'eq', 'x', 'bad name')])).toEqual(['0:target:assertionHeaderName'])
    expect(problems([a('jsonBody', 'eq', 'x')])).toEqual(['0:target:assertionTargetRequired'])
    expect(problems([a('dnsRecord', 'eq', 'x', 'BOGUS')], 'dns')).toEqual([
      '0:target:assertionRecordType',
    ])
    expect(problems([a('status', 'eq', '999')])).toEqual(['0:value:assertionStatusCode'])
    expect(problems([a('jsonBody', 'gt', 'abc', 'x')])).toEqual(['0:value:assertionNumber'])
    expect(problems([a('textBody', 'matches', '(')])).toEqual(['0:value:assertionRegex'])
    expect(problems([a('textBody', 'contains', '')])).toEqual(['0:value:assertionValueRequired'])
  })

  it('allows at most 10 assertions per kind', () => {
    const rows = Array.from({ length: 11 }, () => a('textBody', 'not_contains', 'x'))
    expect(problems(rows)).toEqual(['null:null:assertionTooMany'])
    expect(problems(rows.slice(0, 10))).toEqual([])
  })

  it('normalizeAssertions strips row ids and empty parts', () => {
    expect(
      normalizeAssertions([
        { id: 'abc', kind: 'status', target: '', comparator: 'eq', value: '200' },
        null,
        { kind: 'textBody', comparator: 'empty', value: null },
      ]),
    ).toEqual([
      { kind: 'status', target: null, comparator: 'eq', value: '200' },
      { kind: 'textBody', target: null, comparator: 'empty', value: null },
    ])
  })
})
