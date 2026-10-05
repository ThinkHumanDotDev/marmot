import { describe, expect, it } from 'vitest'

import {
  assertEntitlement,
  effectivePlan,
  EntitlementError,
  entitlementMessage,
  getEntitlements,
  isWithinEntitlement,
  PLAN_LIMITS,
  PLANS,
  serializeEntitlements,
  UNLIMITED_ENTITLEMENTS,
} from './entitlements'

describe('entitlements', () => {
  describe('getEntitlements', () => {
    it('is unlimited for every plan while billing is disabled (self-host default)', () => {
      for (const plan of PLANS) {
        const e = getEntitlements({ plan }, { billingEnabled: false })
        expect(e).toEqual(UNLIMITED_ENTITLEMENTS)
        expect(e.maxMonitors).toBe(Infinity)
        expect(e.customDomains).toBe(true)
      }
      expect(getEntitlements(null, { billingEnabled: false }).maxMembers).toBe(Infinity)
    })

    it('returns the plan table while billing is enabled', () => {
      for (const plan of PLANS) {
        expect(getEntitlements({ plan }, { billingEnabled: true })).toEqual(PLAN_LIMITS[plan])
      }
    })

    it('treats unknown or missing plans as free', () => {
      expect(getEntitlements({ plan: 'gold' }, { billingEnabled: true })).toEqual(PLAN_LIMITS.free)
      expect(getEntitlements(undefined, { billingEnabled: true })).toEqual(PLAN_LIMITS.free)
    })

    it('returns copies so callers cannot mutate the table', () => {
      const e = getEntitlements({ plan: 'team' }, { billingEnabled: true })
      e.maxMonitors = 1
      expect(PLAN_LIMITS.team.maxMonitors).toBe(50)
    })

    it('plans are ordered: each tier allows at least as much as the previous one', () => {
      for (let i = 1; i < PLANS.length; i++) {
        const lower = PLAN_LIMITS[PLANS[i - 1]]
        const upper = PLAN_LIMITS[PLANS[i]]
        expect(upper.maxMonitors).toBeGreaterThanOrEqual(lower.maxMonitors)
        expect(upper.maxMembers).toBeGreaterThanOrEqual(lower.maxMembers)
        expect(upper.maxStatusPages).toBeGreaterThanOrEqual(lower.maxStatusPages)
        expect(upper.minIntervalSeconds).toBeLessThanOrEqual(lower.minIntervalSeconds)
        expect(upper.retentionDays).toBeGreaterThanOrEqual(lower.retentionDays)
      }
      expect(PLAN_LIMITS.enterprise.maxMonitors).toBe(Infinity)
    })
  })

  describe('effectivePlan', () => {
    it('keeps a paid plan while the subscription is active, trialing, past due or manual', () => {
      for (const status of ['active', 'trialing', 'past_due', 'none', undefined, null]) {
        expect(effectivePlan({ plan: 'pro', subscriptionStatus: status })).toBe('pro')
      }
    })

    it('falls back to free once the subscription is canceled or unpaid', () => {
      expect(effectivePlan({ plan: 'team', subscriptionStatus: 'canceled' })).toBe('free')
      expect(effectivePlan({ plan: 'enterprise', subscriptionStatus: 'unpaid' })).toBe('free')
    })

    it('is free for free, unknown and missing plans', () => {
      expect(effectivePlan({ plan: 'free', subscriptionStatus: 'active' })).toBe('free')
      expect(effectivePlan({ plan: 'nope' })).toBe('free')
      expect(effectivePlan(null)).toBe('free')
    })
  })

  describe('isWithinEntitlement / assertEntitlement', () => {
    const free = getEntitlements({ plan: 'free' }, { billingEnabled: true })

    it('allows creates below the limit and refuses at the limit', () => {
      expect(isWithinEntitlement(free, 'monitors', 0)).toBe(true)
      expect(isWithinEntitlement(free, 'monitors', PLAN_LIMITS.free.maxMonitors - 1)).toBe(true)
      expect(isWithinEntitlement(free, 'monitors', PLAN_LIMITS.free.maxMonitors)).toBe(false)
      expect(isWithinEntitlement(free, 'members', 3)).toBe(false)
      expect(isWithinEntitlement(free, 'statusPages', 1)).toBe(false)
      expect(() => assertEntitlement(free, 'statusPages', 0)).not.toThrow()
    })

    it('throws a typed EntitlementError with a readable message', () => {
      let caught: unknown
      try {
        assertEntitlement(free, 'members', 3)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(EntitlementError)
      const err = caught as EntitlementError
      expect(err.code).toBe('entitlement_exceeded')
      expect(err.resource).toBe('members')
      expect(err.limit).toBe(3)
      expect(err.current).toBe(3)
      expect(err.message).toBe('Your plan allows 3 members. Upgrade your plan to add more.')
      expect(entitlementMessage('statusPages', 1)).toBe(
        'Your plan allows 1 status page. Upgrade your plan to add more.',
      )
    })

    it('never throws while unlimited', () => {
      const unlimited = getEntitlements({ plan: 'free' }, { billingEnabled: false })
      expect(() => assertEntitlement(unlimited, 'monitors', 1_000_000)).not.toThrow()
      expect(() => assertEntitlement(PLAN_LIMITS.enterprise, 'members', 1_000_000)).not.toThrow()
    })
  })

  describe('serializeEntitlements', () => {
    it('turns Infinity into null so JSON can carry it', () => {
      expect(serializeEntitlements(UNLIMITED_ENTITLEMENTS)).toEqual({
        maxMonitors: null,
        maxMembers: null,
        maxStatusPages: null,
        minIntervalSeconds: 20,
        retentionDays: null,
        customDomains: true,
      })
      expect(serializeEntitlements(PLAN_LIMITS.free).maxMonitors).toBe(10)
    })
  })
})
