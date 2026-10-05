'use client'

import { ArrowUpRight, CreditCard } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import * as React from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ApiError } from '@/lib/api'
import { billingApi, type BillingOverview } from '@/lib/billing-api'
import { formatLimit, PLAN_LABELS, type Plan } from '@/lib/entitlements'
import { cn } from '@/lib/utils'

interface BillingPanelProps {
  orgId: string | number
  overview: BillingOverview
}

const STATUS_LABEL: Record<BillingOverview['subscriptionStatus'], string> = {
  none: 'No subscription',
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment past due',
  canceled: 'Canceled',
  unpaid: 'Unpaid',
}

const statusVariant = (
  status: BillingOverview['subscriptionStatus'],
): 'default' | 'secondary' | 'destructive' | 'outline' => {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'default'
    case 'past_due':
    case 'unpaid':
      return 'destructive'
    case 'canceled':
      return 'outline'
    default:
      return 'secondary'
  }
}

function UsageRow({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const unlimited = limit === null
  const ratio = unlimited ? 0 : Math.min(1, used / Math.max(limit, 1))
  const full = !unlimited && used >= limit
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className={cn('tabular-nums', full ? 'text-destructive' : 'text-muted-foreground')}>
          {used} / {formatLimit(limit)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={unlimited ? undefined : limit}
        aria-valuenow={used}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn('h-full rounded-full', full ? 'bg-destructive' : 'bg-primary')}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  )
}

/**
 * Current plan, usage against the plan's limits, and the Stripe actions (Checkout to upgrade,
 * Billing Portal to manage payment details and cancel). Rendered only for admins and owners
 * while `BILLING_ENABLED` is on.
 */
export function BillingPanel({ orgId, overview }: BillingPanelProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, setPending] = React.useState<string | null>(null)
  const notified = React.useRef(false)

  React.useEffect(() => {
    if (notified.current) return
    const checkout = searchParams.get('checkout')
    if (checkout === 'success') {
      notified.current = true
      toast.success('Thanks! Your plan updates as soon as Stripe confirms the payment.')
      router.replace(window.location.pathname)
    } else if (checkout === 'canceled') {
      notified.current = true
      toast.message('Checkout canceled. Your plan is unchanged.')
      router.replace(window.location.pathname)
    }
  }, [router, searchParams])

  async function redirectTo(key: string, action: () => Promise<{ url: string }>) {
    setPending(key)
    try {
      const { url } = await action()
      window.location.assign(url)
    } catch (error) {
      setPending(null)
      toast.error(error instanceof ApiError ? error.message : 'Something went wrong')
    }
  }

  const upgrade = (plan: Plan) =>
    redirectTo(`checkout:${plan}`, () => billingApi.checkout(orgId, plan))
  const manage = () => redirectTo('portal', () => billingApi.portal(orgId))

  const { entitlements, usage } = overview
  const lapsed = overview.effectivePlan !== overview.plan

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <CardTitle>Current plan</CardTitle>
              <CardDescription>
                {lapsed
                  ? `Your ${overview.planLabel} subscription has lapsed, so the ${PLAN_LABELS[overview.effectivePlan]} limits apply.`
                  : 'Limits apply to new monitors, members and status pages.'}
              </CardDescription>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <span className="text-lg font-semibold">{overview.planLabel}</span>
              <Badge variant={statusVariant(overview.subscriptionStatus)}>
                {STATUS_LABEL[overview.subscriptionStatus]}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <UsageRow label="Monitors" used={usage.monitors} limit={entitlements.maxMonitors} />
          <UsageRow label="Members" used={usage.members} limit={entitlements.maxMembers} />
          <UsageRow
            label="Status pages"
            used={usage.statusPages}
            limit={entitlements.maxStatusPages}
          />
          <dl className="grid grid-cols-1 gap-2 pt-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Minimum interval</dt>
              <dd className="tabular-nums">{entitlements.minIntervalSeconds}s</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Data retention</dt>
              <dd className="tabular-nums">
                {entitlements.retentionDays === null
                  ? 'Unlimited'
                  : `${entitlements.retentionDays} days`}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Custom domains</dt>
              <dd>{entitlements.customDomains ? 'Included' : 'Not included'}</dd>
            </div>
          </dl>
        </CardContent>
        {overview.stripeConfigured ? (
          <CardFooter className="flex flex-wrap gap-2">
            {overview.upgrades.map((plan) => (
              <Button
                key={plan}
                onClick={() => upgrade(plan)}
                disabled={pending !== null}
                variant={plan === overview.upgrades[0] ? 'default' : 'outline'}
              >
                <ArrowUpRight aria-hidden />
                {pending === `checkout:${plan}`
                  ? 'Redirecting…'
                  : `Upgrade to ${PLAN_LABELS[plan]}`}
              </Button>
            ))}
            {(overview.hasCustomer || overview.upgrades.length === 0) && (
              <Button variant="outline" onClick={manage} disabled={pending !== null}>
                <CreditCard aria-hidden />
                {pending === 'portal' ? 'Redirecting…' : 'Manage billing'}
              </Button>
            )}
          </CardFooter>
        ) : (
          <CardFooter>
            <p className="text-sm text-muted-foreground">
              Stripe is not configured on this instance, so plans can only be changed by an instance
              administrator.
            </p>
          </CardFooter>
        )}
      </Card>
    </>
  )
}
