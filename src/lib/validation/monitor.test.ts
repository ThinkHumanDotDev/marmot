import { describe, expect, it } from 'vitest'

import { getTranslator } from '@/i18n/translator'

import { createMonitorFormSchema, defaultMonitorValues, humanDuration } from './monitor'
import { monitorFormSchema } from './monitor-schema'

const issuesOf = (result: {
  error?: { issues: { path: PropertyKey[]; message: string }[] }
}): Record<string, string> =>
  Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.join('.'), issue.message]),
  )

describe('monitor form validation messages', () => {
  it('answers in English by default (route handlers, imports)', () => {
    const result = monitorFormSchema.safeParse({
      ...defaultMonitorValues('http'),
      name: '',
      url: '',
      interval: 5,
      headers: 'not json',
    })
    expect(result.success).toBe(false)
    expect(issuesOf(result)).toMatchObject({
      name: 'Name is required',
      url: 'URL is required',
      interval: 'At least 20 seconds',
      headers: 'Headers must be a JSON object, e.g. {"X-Token": "abc"}',
    })
  })

  it('takes its messages from the translator it is built with (the form)', () => {
    const t = getTranslator('en')
    const seen: string[] = []
    const schema = createMonitorFormSchema((key, values) => {
      seen.push(key)
      return `[${t(`monitors.validation.${key}`, values)}]`
    })
    const result = schema.safeParse({
      ...defaultMonitorValues('postgres'),
      name: 'db',
      databaseConnectionString: 'mysql://x',
    })
    expect(issuesOf(result)).toMatchObject({
      databaseConnectionString:
        '[Use a connection string like postgres://user:password@host:5432/database]',
    })
    expect(seen).toContain('connectionStringScheme')
  })
})

describe('humanDuration', () => {
  it('renders English by default and delegates units to the translator', () => {
    expect(humanDuration(90)).toBe('1 minute 30 seconds')
    expect(humanDuration(0)).toBe('0 seconds')
    const t = getTranslator('en')
    expect(
      humanDuration(86_400 + 7_200, (unit, count) => t(`common.duration.${unit}`, { count })),
    ).toBe('1 day 2 hours')
  })
})
