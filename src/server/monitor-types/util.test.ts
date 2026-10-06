import { describe, expect, it } from 'vitest'

import {
  checkTimeoutMs,
  isModuleNotFound,
  loadOptionalDriver,
  parseJsonObject,
  withAbort,
} from './util'

describe('isModuleNotFound', () => {
  it('recognises Node resolution errors by code and message', () => {
    expect(isModuleNotFound(Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' }))).toBe(
      true,
    )
    expect(isModuleNotFound(Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' }))).toBe(true)
    expect(isModuleNotFound(new Error("Cannot find package 'mysql2' imported from /app"))).toBe(
      true,
    )
    expect(isModuleNotFound(new Error("Cannot find module 'pg'"))).toBe(true)
  })

  it('looks through wrapped errors', () => {
    const wrapped = new Error('loader failed', {
      cause: Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }),
    })
    expect(isModuleNotFound(wrapped)).toBe(true)
  })

  it('leaves other errors alone', () => {
    expect(isModuleNotFound(new Error('ECONNREFUSED'))).toBe(false)
    expect(isModuleNotFound(null)).toBe(false)
  })
})

describe('loadOptionalDriver', () => {
  it('returns the module when the import works', async () => {
    await expect(loadOptionalDriver(async () => ({ ok: true }), 'pkg', 'Test')).resolves.toEqual({
      ok: true,
    })
  })

  it('turns a missing module into an install hint', async () => {
    const load = () =>
      Promise.reject(
        Object.assign(new Error("Cannot find package 'pkg'"), { code: 'ERR_MODULE_NOT_FOUND' }),
      )
    await expect(loadOptionalDriver(load, 'pkg', 'Test')).rejects.toThrow(
      'The "pkg" package is not installed. Install pkg to use the Test monitor (pnpm add pkg).',
    )
  })

  it('rethrows unrelated failures untouched', async () => {
    await expect(
      loadOptionalDriver(() => Promise.reject(new Error('native binding broke')), 'pkg', 'Test'),
    ).rejects.toThrow('native binding broke')
  })
})

describe('checkTimeoutMs', () => {
  it('uses the timeout, or 80% of the interval when it is 0', () => {
    expect(checkTimeoutMs({ timeout: 5, interval: 60 })).toBe(5000)
    expect(checkTimeoutMs({ timeout: 0, interval: 60 })).toBe(48_000)
    expect(checkTimeoutMs({ timeout: 0.2, interval: 60 })).toBe(200)
  })
})

describe('withAbort', () => {
  it('passes the value through when the signal stays quiet', async () => {
    await expect(withAbort(Promise.resolve(1), new AbortController().signal)).resolves.toBe(1)
  })

  it('rejects and runs the cleanup when the signal fires first', async () => {
    const controller = new AbortController()
    let cleaned = false
    const pending = withAbort(new Promise<never>(() => {}), controller.signal, () => {
      cleaned = true
    })
    controller.abort()
    await expect(pending).rejects.toThrow('timeout by AbortSignal')
    expect(cleaned).toBe(true)
  })

  it('rejects immediately on an already aborted signal', async () => {
    await expect(withAbort(Promise.resolve(1), AbortSignal.abort())).rejects.toMatchObject({
      name: 'TimeoutError',
    })
  })
})

describe('parseJsonObject', () => {
  it('accepts empty input and JSON objects, rejects the rest', () => {
    expect(parseJsonObject(null, 'X')).toEqual({})
    expect(parseJsonObject('  ', 'X')).toEqual({})
    expect(parseJsonObject('{"a": 1}', 'X')).toEqual({ a: 1 })
    expect(() => parseJsonObject('[1]', 'Metadata')).toThrow('Metadata must be a JSON object')
    expect(() => parseJsonObject('{nope', 'Body')).toThrow(/Body must be valid JSON/)
  })
})
