import { describe, expect, it } from 'vitest'

import { defaultMaintenanceValues } from './validation/maintenance'
import { addMinutesInZone, fromZonedInput, toZonedInput } from './zoned-time'

describe('zoned date pickers (#271)', () => {
  it('writes and reads datetime-local values in the given zone, not the browser’s', () => {
    const instant = new Date('2026-07-01T12:30:00Z')
    expect(toZonedInput(instant, 'Europe/Berlin')).toBe('2026-07-01T14:30')
    expect(toZonedInput(instant, 'America/New_York')).toBe('2026-07-01T08:30')
    expect(fromZonedInput('2026-07-01T14:30', 'Europe/Berlin')?.toISOString()).toBe(
      instant.toISOString(),
    )
    expect(fromZonedInput('2026-07-01T08:30', 'America/New_York')?.toISOString()).toBe(
      instant.toISOString(),
    )
  })

  it('takes instants with an offset as they are and rejects anything else', () => {
    expect(fromZonedInput('2026-07-01T12:30:00.000Z', 'Asia/Tokyo')?.toISOString()).toBe(
      '2026-07-01T12:30:00.000Z',
    )
    expect(fromZonedInput('', 'UTC')).toBeNull()
    expect(fromZonedInput(null, 'UTC')).toBeNull()
    expect(fromZonedInput('tomorrow', 'UTC')).toBeNull()
    expect(fromZonedInput('2026-13-45T99:99', 'UTC')).toBeNull()
  })

  it('adds durations across DST changes in wall-clock terms', () => {
    // Europe/Berlin springs forward on 2026-03-29 at 02:00: one hour after 01:30 is 03:30.
    expect(addMinutesInZone('2026-03-29T01:30', 60, 'Europe/Berlin')).toBe('2026-03-29T03:30')
    expect(addMinutesInZone('2026-07-01T23:30', 60, 'UTC')).toBe('2026-07-02T00:30')
    expect(addMinutesInZone('', 60, 'UTC')).toBeNull()
  })

  it('starts a new maintenance window now in the organization zone', () => {
    const now = new Date('2026-07-01T12:30:00Z')
    expect(defaultMaintenanceValues(now, 'Asia/Tokyo').dateRange).toEqual({
      start: '2026-07-01T21:30',
      end: '2026-07-01T22:30',
    })
  })
})
