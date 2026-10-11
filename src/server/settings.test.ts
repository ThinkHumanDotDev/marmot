import type { Payload } from 'payload'
import { afterEach, describe, expect, it, vi } from 'vitest'

type SettingsModule = typeof import('./settings')

/** A fresh evaluation of the module, like the separate copies a production Next.js server loads. */
async function loadCopy(): Promise<SettingsModule> {
  vi.resetModules()
  return import('./settings')
}

const fakePayload = (doc: Record<string, unknown>) =>
  ({
    findGlobal: vi.fn(async () => doc),
    logger: { warn: vi.fn() },
  }) as unknown as Payload & { findGlobal: ReturnType<typeof vi.fn> }

describe('instance settings cache', () => {
  afterEach(async () => (await import('./settings')).resetInstanceSettingsCache())

  it('is shared by every copy of the module, so one reset reaches all of them', async () => {
    const page = await loadCopy()
    const route = await loadCopy()
    page.resetInstanceSettingsCache()

    const before = fakePayload({ magicLinkEnabled: false })
    expect((await page.getInstanceSettings(before)).magicLinkEnabled).toBe(false)
    // The other copy reads the same cached value instead of the database.
    expect((await route.getInstanceSettings(before)).magicLinkEnabled).toBe(false)
    expect(before.findGlobal).toHaveBeenCalledTimes(1)

    // Saving the global resets the cache in the copy that handled the save (`afterChange`)...
    route.resetInstanceSettingsCache()
    const after = fakePayload({ magicLinkEnabled: true })
    // ...and the next read through any copy sees the new value.
    expect((await page.getInstanceSettings(after)).magicLinkEnabled).toBe(true)
  })
})
