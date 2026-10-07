import { describe, expect, it } from 'vitest'

import { diffDocs, maskUrlCredentials, MAX_STRING_LENGTH, REDACTED, snapshot } from './diff'

describe('audit diff', () => {
  it('reports changed top-level fields with their values', () => {
    const diff = diffDocs(
      { id: 1, name: 'API', active: true, interval: 60, updatedAt: 'a' },
      { id: 1, name: 'API', active: false, interval: 60, updatedAt: 'b' },
    )
    expect(diff).toEqual({
      changedFields: ['active'],
      before: { active: true },
      after: { active: false },
    })
  })

  it('treats null, empty strings and empty arrays as equal', () => {
    const diff = diffDocs({ description: null, tags: [] }, { description: '', tags: null })
    expect(diff.changedFields).toEqual([])
  })

  it('diffs groups key by key and collapses populated relationships to ids', () => {
    const diff = diffDocs(
      { config: { channel: '#ops', username: 'bot' }, proxy: 3 },
      {
        config: { channel: '#alerts', username: 'bot' },
        proxy: { id: 3, host: 'p', createdAt: 'x' },
      },
    )
    expect(diff.changedFields).toEqual(['config.channel'])
    expect(diff.after).toEqual({ 'config.channel': '#alerts' })
  })

  it('names a changed secret without revealing either value', () => {
    const diff = diffDocs(
      { config: { webhookUrl: 'https://hooks.slack.com/old' }, auth: { password: 'a' } },
      { config: { webhookUrl: 'https://hooks.slack.com/new' }, auth: { password: 'a' } },
    )
    expect(diff.changedFields).toEqual(['config.webhookUrl'])
    expect(diff.before['config.webhookUrl']).toBe(REDACTED)
    expect(diff.after['config.webhookUrl']).toBe(REDACTED)
    expect(JSON.stringify(diff)).not.toContain('hooks.slack.com')
  })

  it('redacts secrets found by name, by provider metadata and inside URLs', () => {
    const doc = {
      name: 'Channel',
      config: {
        botToken: 'xoxb-1',
        routingKey: 'r-123',
        url: 'https://user:hunter2@example.com/hook',
        headers: { Authorization: 'Bearer abc' },
      },
      basicAuthPass: 'p',
      keyHash: 'deadbeef',
    }
    const out = snapshot(doc, { secretKeys: ['routingKey'] })
    const text = JSON.stringify(out)
    for (const secret of ['xoxb-1', 'r-123', 'hunter2', 'Bearer abc', 'deadbeef']) {
      expect(text).not.toContain(secret)
    }
    expect(out.name).toBe('Channel')
    expect((out.config as Record<string, unknown>).url).toBe(
      `https://user:${REDACTED}@example.com/hook`,
    )
  })

  it('leaves out ignored fields and truncates long strings', () => {
    const out = snapshot(
      { status: { lastStatus: 'up' }, css: 'x'.repeat(MAX_STRING_LENGTH + 10), createdAt: 'now' },
      { ignore: ['status'] },
    )
    expect(Object.keys(out)).toEqual(['css'])
    expect((out.css as string).length).toBe(MAX_STRING_LENGTH + 1)
  })

  it('masks only the password part of URL credentials', () => {
    expect(maskUrlCredentials('redis://default:s3cret@cache:6379')).toBe(
      `redis://default:${REDACTED}@cache:6379`,
    )
    expect(maskUrlCredentials('https://example.com/a@b')).toBe('https://example.com/a@b')
  })
})
