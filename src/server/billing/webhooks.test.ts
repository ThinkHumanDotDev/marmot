import { describe, expect, it, vi } from 'vitest'

import type { Payload } from 'payload'

import {
  handleCustomerDeleted,
  handleSubscriptionEvent,
  mapSubscriptionStatus,
  planFromSubscription,
  type StripeSubscriptionLike,
  type SubscriptionEventLike,
} from './webhooks'

type OrgRow = {
  id: number
  plan?: string | null
  subscriptionStatus?: string | null
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
}

/** Just enough of the Local API for the handlers: `find` over `or`/`equals`, `findByID`, `update`. */
function fakePayload(rows: OrgRow[]) {
  const orgs = rows.map((row) => ({ ...row }))
  const matches = (org: OrgRow, clause: Record<string, { equals: unknown }>) =>
    Object.entries(clause).every(([field, { equals }]) => org[field as keyof OrgRow] === equals)
  const update = vi.fn(async ({ id, data }: { id: number; data: Partial<OrgRow> }) => {
    const org = orgs.find((row) => row.id === id)!
    Object.assign(org, data)
    return org
  })
  const payload = {
    db: { defaultIDType: 'number' },
    find: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const clauses = (where.or as Record<string, { equals: unknown }>[] | undefined) ?? [where]
      const docs = orgs.filter((org) =>
        clauses.some((clause) => matches(org, clause as Record<string, { equals: unknown }>)),
      )
      return { docs, totalDocs: docs.length }
    }),
    findByID: vi.fn(async ({ id }: { id: number | string }) => {
      return orgs.find((row) => String(row.id) === String(id)) ?? null
    }),
    update,
  }
  return { payload: payload as unknown as Payload, orgs, update }
}

const subscription = (over: Partial<StripeSubscriptionLike> = {}): StripeSubscriptionLike => ({
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  items: { data: [{ price: { id: 'price_1', metadata: { plan: 'team' }, product: 'prod_1' } }] },
  ...over,
})

const event = (
  type: SubscriptionEventLike['type'],
  object: StripeSubscriptionLike,
): SubscriptionEventLike => ({ id: 'evt_1', type, data: { object } })

describe('stripe webhooks', () => {
  it('maps Stripe subscription statuses onto the organization field', () => {
    expect(mapSubscriptionStatus('active')).toBe('active')
    expect(mapSubscriptionStatus('trialing')).toBe('trialing')
    expect(mapSubscriptionStatus('past_due')).toBe('past_due')
    expect(mapSubscriptionStatus('canceled')).toBe('canceled')
    expect(mapSubscriptionStatus('unpaid')).toBe('unpaid')
    expect(mapSubscriptionStatus('paused')).toBe('past_due')
    expect(mapSubscriptionStatus('incomplete_expired')).toBe('canceled')
    expect(mapSubscriptionStatus('incomplete')).toBe('none')
    expect(mapSubscriptionStatus('something_new')).toBe('none')
  })

  describe('planFromSubscription', () => {
    it('prefers price metadata, then the expanded product, then the subscription metadata', async () => {
      expect(await planFromSubscription(subscription())).toBe('team')
      expect(
        await planFromSubscription(
          subscription({
            items: {
              data: [{ price: { id: 'p', product: { id: 'prod', metadata: { plan: 'pro' } } } }],
            },
          }),
        ),
      ).toBe('pro')
      expect(
        await planFromSubscription(
          subscription({ items: { data: [] }, metadata: { plan: 'enterprise' } }),
        ),
      ).toBe('enterprise')
    })

    it('resolves an unexpanded product through the callback and ignores unknown plans', async () => {
      const resolve = vi.fn(async () => 'pro')
      expect(
        await planFromSubscription(
          subscription({ items: { data: [{ price: { id: 'p', product: 'prod_9' } }] } }),
          resolve,
        ),
      ).toBe('pro')
      expect(resolve).toHaveBeenCalledWith('prod_9')
      expect(
        await planFromSubscription(
          subscription({ items: { data: [{ price: { id: 'p', metadata: { plan: 'gold' } } }] } }),
        ),
      ).toBeNull()
    })
  })

  describe('handleSubscriptionEvent', () => {
    it('created: finds the organization by customer and stores plan, status and ids', async () => {
      const { payload, orgs } = fakePayload([
        { id: 1, plan: 'free', subscriptionStatus: 'none', stripeCustomerId: 'cus_1' },
        { id: 2, plan: 'free', stripeCustomerId: 'cus_other' },
      ])
      const change = await handleSubscriptionEvent(
        payload,
        event('customer.subscription.created', subscription({ status: 'trialing' })),
      )
      expect(change).toEqual({
        organization: 1,
        plan: 'team',
        subscriptionStatus: 'trialing',
        stripeSubscriptionId: 'sub_1',
        stripeCustomerId: 'cus_1',
      })
      expect(orgs[0]).toMatchObject({
        plan: 'team',
        subscriptionStatus: 'trialing',
        stripeSubscriptionId: 'sub_1',
      })
      expect(orgs[1].plan).toBe('free')
    })

    it('updated: matches by subscription id first and follows plan changes', async () => {
      const { payload, orgs } = fakePayload([
        { id: 1, plan: 'team', subscriptionStatus: 'active', stripeCustomerId: 'cus_1' },
        {
          id: 2,
          plan: 'team',
          subscriptionStatus: 'active',
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
        },
      ])
      await handleSubscriptionEvent(
        payload,
        event(
          'customer.subscription.updated',
          subscription({
            status: 'past_due',
            items: { data: [{ price: { id: 'price_2', metadata: { plan: 'pro' } } }] },
          }),
        ),
      )
      expect(orgs[1]).toMatchObject({ plan: 'pro', subscriptionStatus: 'past_due' })
      expect(orgs[0]).toMatchObject({ plan: 'team', subscriptionStatus: 'active' })
    })

    it('keeps the current plan when the subscription carries no known plan metadata', async () => {
      const { payload, orgs } = fakePayload([
        { id: 1, plan: 'pro', subscriptionStatus: 'active', stripeCustomerId: 'cus_1' },
      ])
      await handleSubscriptionEvent(
        payload,
        event('customer.subscription.updated', subscription({ items: { data: [] } })),
      )
      expect(orgs[0]).toMatchObject({ plan: 'pro', subscriptionStatus: 'active' })
    })

    it('deleted: downgrades to free, marks canceled and clears the subscription id', async () => {
      const { payload, orgs } = fakePayload([
        {
          id: 1,
          plan: 'pro',
          subscriptionStatus: 'active',
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
        },
      ])
      const change = await handleSubscriptionEvent(
        payload,
        event('customer.subscription.deleted', subscription({ status: 'canceled' })),
      )
      expect(change?.plan).toBe('free')
      expect(orgs[0]).toMatchObject({
        plan: 'free',
        subscriptionStatus: 'canceled',
        stripeSubscriptionId: null,
        stripeCustomerId: 'cus_1',
      })
    })

    it('falls back to subscription metadata.organizationId for a customer we have not stored', async () => {
      const { payload, orgs } = fakePayload([{ id: 7, plan: 'free' }])
      await handleSubscriptionEvent(
        payload,
        event(
          'customer.subscription.created',
          subscription({ customer: { id: 'cus_new' }, metadata: { organizationId: '7' } }),
        ),
      )
      expect(orgs[0]).toMatchObject({
        plan: 'team',
        subscriptionStatus: 'active',
        stripeCustomerId: 'cus_new',
      })
    })

    it('returns null and writes nothing for an unknown subscription', async () => {
      const { payload, update } = fakePayload([{ id: 1, stripeCustomerId: 'cus_x' }])
      const change = await handleSubscriptionEvent(
        payload,
        event('customer.subscription.updated', subscription()),
      )
      expect(change).toBeNull()
      expect(update).not.toHaveBeenCalled()
    })
  })

  it('customer.deleted forgets the customer and resets the plan', async () => {
    const { payload, orgs } = fakePayload([
      { id: 1, plan: 'team', subscriptionStatus: 'active', stripeCustomerId: 'cus_1' },
    ])
    const id = await handleCustomerDeleted(payload, {
      type: 'customer.deleted',
      data: { object: { id: 'cus_1' } },
    })
    expect(id).toBe(1)
    expect(orgs[0]).toMatchObject({
      plan: 'free',
      subscriptionStatus: 'none',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    })
  })
})
