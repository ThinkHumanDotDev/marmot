import { describe, expect, it } from 'vitest'

import { canPostStatus, OCCURRENCE_STATES } from '@/lib/maintenance-announcements'
import { eventTypeFor } from './events'
import { effectiveMaintenanceStatus } from './occurrences'

describe('occurrence transitions', () => {
  it('allows notes in every state and only forward moves otherwise', () => {
    for (const state of OCCURRENCE_STATES) expect(canPostStatus(state, state)).toBe(true)
    expect(canPostStatus('scheduled', 'in-progress')).toBe(true)
    expect(canPostStatus('scheduled', 'cancelled')).toBe(true)
    expect(canPostStatus('scheduled', 'completed')).toBe(false)
    expect(canPostStatus('in-progress', 'cancelled')).toBe(false)
    expect(canPostStatus('verifying', 'in-progress')).toBe(true)
    expect(canPostStatus('completed', 'in-progress')).toBe(false)
    expect(canPostStatus('cancelled', 'scheduled')).toBe(false)
  })

  it('names the event of each change', () => {
    expect(eventTypeFor('scheduled', 'in-progress')).toBe('started')
    expect(eventTypeFor('verifying', 'completed')).toBe('completed')
    expect(eventTypeFor('scheduled', 'cancelled')).toBe('cancelled')
    expect(eventTypeFor('in-progress', 'verifying')).toBe('updated')
    expect(eventTypeFor('verifying', 'in-progress')).toBe('updated')
    expect(eventTypeFor('in-progress', 'in-progress')).toBe('updated')
  })
})

describe('effectiveMaintenanceStatus', () => {
  const single = { active: true, strategy: 'single' as const }
  const window = { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' }

  it('follows the occurrences rather than the clock', () => {
    // Inside the planned window but not started (autoStart off): not under maintenance.
    expect(
      effectiveMaintenanceStatus(single, { status: 'under-maintenance', next: null }, [
        { state: 'scheduled' },
      ]),
    ).toBe('scheduled')
    // Past the planned end but not completed (autoComplete off): still under maintenance.
    expect(
      effectiveMaintenanceStatus(single, { status: 'ended', next: null }, [
        { state: 'in-progress' },
      ]),
    ).toBe('under-maintenance')
    expect(
      effectiveMaintenanceStatus(single, { status: 'ended', next: null }, [{ state: 'verifying' }]),
    ).toBe('under-maintenance')
    // Completed or cancelled early.
    expect(
      effectiveMaintenanceStatus(single, { status: 'under-maintenance', next: null }, [
        { state: 'completed' },
      ]),
    ).toBe('ended')
    expect(
      effectiveMaintenanceStatus(single, { status: 'under-maintenance', next: window }, [
        { state: 'cancelled' },
      ]),
    ).toBe('scheduled')
  })

  it('reports paused and manual maintenances', () => {
    expect(
      effectiveMaintenanceStatus({ ...single, active: false }, { status: 'inactive', next: null }, [
        { state: 'in-progress' },
      ]),
    ).toBe('inactive')
    const manual = { active: true, strategy: 'manual' as const }
    expect(
      effectiveMaintenanceStatus(manual, { status: 'under-maintenance', next: null }, [
        { state: 'in-progress' },
      ]),
    ).toBe('under-maintenance')
  })
})
