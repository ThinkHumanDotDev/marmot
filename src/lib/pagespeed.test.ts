import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { applyPagespeed, mergeBucketPagespeed } from '@/server/stats/uptime-calculator'

import {
  describeFailures,
  evaluatePagespeed,
  fieldInp,
  LighthouseRuntimeError,
  monitorCategories,
  pagespeedReportUrl,
  pagespeedSeriesValues,
  parseLighthouseResult,
  parsePagespeedRun,
} from './pagespeed'

const fixture = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/pagespeed/psi-mobile.json'), 'utf8'),
) as { lighthouseResult: Record<string, unknown> }

describe('parseLighthouseResult', () => {
  it('reads the category scores (0–100) and the lab metrics of a recorded answer', () => {
    expect(parseLighthouseResult(fixture.lighthouseResult)).toEqual({
      scores: { performance: 91, accessibility: 97, 'best-practices': 100, seo: 92 },
      metrics: { lcp: 2613, fcp: 1503, tbt: 122, si: 2104, ttfb: 87, cls: 0.021 },
      finalUrl: 'https://www.example.com/',
      lighthouseVersion: '12.8.2',
    })
    expect(fieldInp(fixture)).toBe(143)
  })

  it('leaves out categories Lighthouse could not score and throws on a failed run', () => {
    const lhr = structuredClone(fixture.lighthouseResult) as {
      categories: Record<string, { score: number | null }>
    }
    lhr.categories.seo.score = null
    expect(parseLighthouseResult(lhr).scores).not.toHaveProperty('seo')

    expect(() =>
      parseLighthouseResult({
        ...fixture.lighthouseResult,
        runtimeError: { code: 'NO_FCP', message: 'The page did not paint any content.' },
      }),
    ).toThrow(
      new LighthouseRuntimeError(
        'NO_FCP',
        'Lighthouse failed: The page did not paint any content.',
      ),
    )
    expect(() => parseLighthouseResult(undefined)).toThrow('no Lighthouse result')
  })
})

describe('evaluatePagespeed', () => {
  const scores = { performance: 54, accessibility: 97, 'best-practices': 100 }

  it('reports each category below its minimum, unscored ones included', () => {
    const failures = evaluatePagespeed(scores, { performance: 70, accessibility: 90, seo: 80 })
    expect(failures).toEqual([
      { category: 'performance', score: 54, min: 70 },
      { category: 'seo', score: null, min: 80 },
    ])
    expect(describeFailures(failures)).toBe('performance 54 < 70, seo not scored < 80')
  })

  it('ignores categories without a minimum or not run', () => {
    expect(evaluatePagespeed(scores, { performance: 50 })).toEqual([])
    expect(evaluatePagespeed(scores, { seo: 80 }, ['performance'])).toEqual([])
  })
})

describe('helpers', () => {
  it('defaults to every category', () => {
    expect(monitorCategories(null)).toEqual([
      'performance',
      'accessibility',
      'best-practices',
      'seo',
    ])
    expect(monitorCategories(['seo', 'performance', 'bogus'])).toEqual(['performance', 'seo'])
  })

  it('links the PageSpeed Insights report of the URL', () => {
    expect(pagespeedReportUrl('https://example.com/a?b=1', 'desktop')).toBe(
      'https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&form_factor=desktop',
    )
  })

  it('parses stored runs defensively and flattens them for the rollups', () => {
    expect(parsePagespeedRun({ scores: 'x' })).toBeNull()
    const run = {
      backend: 'psi',
      strategy: 'mobile',
      scores: { performance: 91, seo: 'bad' },
      metrics: { lcp: 2613, cls: 0.021 },
      reportUrl: null,
    }
    expect(parsePagespeedRun(run)).toMatchObject({ scores: { performance: 91 } })
    expect(pagespeedSeriesValues(run)).toEqual({ performance: 91, lcp: 2613, cls: 0.021 })
    expect(pagespeedSeriesValues({ scores: {}, metrics: {} })).toBeNull()
  })

  it('rolls up runs per key and merges buckets', () => {
    const one = applyPagespeed(undefined, { performance: 90, lcp: 2000 })
    const two = applyPagespeed(one, { performance: 50 })
    expect(two).toEqual({
      performance: { avg: 70, min: 50, max: 90, count: 2 },
      lcp: { avg: 2000, min: 2000, max: 2000, count: 1 },
    })
    expect(
      mergeBucketPagespeed([
        { pagespeed: two },
        {},
        { pagespeed: { performance: { avg: 100, min: 100, max: 100, count: 1 } } },
      ]),
    ).toEqual({
      performance: { avg: 80, min: 50, max: 100, count: 3 },
      lcp: { avg: 2000, min: 2000, max: 2000, count: 1 },
    })
    expect(mergeBucketPagespeed([{}, null])).toBeNull()
  })
})
