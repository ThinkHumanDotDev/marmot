import { CheckIcon } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getFormatter, getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { LandingFooter, LandingHeader, REPO_URL } from '@/components/landing/landing-chrome'
import { Button } from '@/components/ui/button'
import { getCurrentUser, getUserOrganizations, homePathFor, type OrgMembership } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { getPricingPlans, type PlanPrice, type PricingPlan } from '@/server/billing/pricing'
import { isSignupAllowed } from '@/server/settings'
import { getSiteLinks } from '@/server/site-links'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('pricing')
  return { title: t('pageTitle') }
}
export const dynamic = 'force-dynamic'

const GETTING_STARTED_URL = `${REPO_URL}/blob/main/docs/Getting-Started.md`

/** Where a signed-in visitor manages their plan: the Billing tab of an organization they administer. */
function billingPathFor(organizations: OrgMembership[]): string {
  const managed = organizations.find((org) => org.role === 'owner' || org.role === 'admin')
  return managed ? `/${managed.slug}/settings/billing` : homePathFor(organizations)
}

/**
 * `/pricing` (#178): the hosted plans with their limits (`PLAN_LIMITS`) and Stripe prices. Only
 * exists while `LANDING_PAGE_ENABLED` and `BILLING_ENABLED` are both on; 404 otherwise.
 */
export default async function PricingPage() {
  const plans = await getPricingPlans()
  if (!plans) notFound()

  const user = await getCurrentUser()
  const [t, format, signupEnabled] = await Promise.all([
    getTranslations('pricing'),
    getFormatter(),
    isSignupAllowed(await getPayload({ config })),
  ])
  const organizations = user ? await getUserOrganizations(user) : []
  const cta = user
    ? { href: billingPathFor(organizations), label: t('cta.billing') }
    : signupEnabled
      ? { href: '/signup', label: t('cta.signUp') }
      : { href: '/login', label: t('cta.signIn') }

  // Without Stripe prices the cards skip the empty price row instead of reserving space for it.
  const anyPrice = plans.some((plan) => plan.prices.month || plan.prices.year)
  const money = (price: PlanPrice) =>
    format.number(price.amount, {
      style: 'currency',
      currency: price.currency,
      maximumFractionDigits: Number.isInteger(price.amount) ? 0 : 2,
    })

  const features = (plan: PricingPlan): string[] => {
    const { limits } = plan
    return [
      limits.maxMonitors === null
        ? t('limits.monitorsUnlimited')
        : t('limits.monitors', { count: limits.maxMonitors }),
      limits.maxMembers === null
        ? t('limits.membersUnlimited')
        : t('limits.members', { count: limits.maxMembers }),
      limits.maxStatusPages === null
        ? t('limits.statusPagesUnlimited')
        : t('limits.statusPages', { count: limits.maxStatusPages }),
      t('limits.interval', { seconds: limits.minIntervalSeconds ?? 0 }),
      limits.retentionDays === null
        ? t('limits.retentionUnlimited')
        : t('limits.retention', { days: limits.retentionDays }),
      limits.customDomains ? t('limits.customDomains') : t('limits.noCustomDomains'),
    ]
  }

  return (
    <div className="flex min-h-dvh flex-col bg-sidebar">
      <LandingHeader
        signupEnabled={signupEnabled}
        pricingEnabled
        dashboardHref={user ? homePathFor(organizations) : null}
      />
      <main className="flex-1">
        <section className="mx-auto w-full max-w-6xl px-4 pt-12 pb-20 sm:px-6 lg:pt-20">
          <div className="max-w-2xl">
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              {t('title')}
            </h1>
            <p className="mt-5 text-lg text-pretty text-muted-foreground">{t('description')}</p>
          </div>
          <ul
            className={cn(
              'mt-12 grid gap-6',
              plans.length >= 3 ? 'md:grid-cols-3' : 'md:grid-cols-2',
            )}
          >
            {plans.map((plan, index) => {
              const highlighted = plan.purchasable && index === 1
              return (
                <li
                  key={plan.plan}
                  data-testid={`pricing-plan-${plan.plan}`}
                  className={cn(
                    'flex flex-col rounded-xl border bg-card p-6 text-card-foreground shadow-sm',
                    highlighted && 'border-primary ring-1 ring-primary',
                  )}
                >
                  <h2 className="text-lg font-semibold">{plan.label}</h2>
                  <div className={cn('mt-4', anyPrice && 'min-h-16')}>
                    {!plan.purchasable ? (
                      <p className="text-3xl font-semibold tracking-tight">{t('free')}</p>
                    ) : plan.prices.month ? (
                      <>
                        <p className="text-3xl font-semibold tracking-tight">
                          {money(plan.prices.month)}{' '}
                          <span className="text-base font-normal text-muted-foreground">
                            {t('perMonth')}
                          </span>
                        </p>
                        {plan.prices.year && (
                          <p className="mt-1 text-sm text-muted-foreground">
                            {t('perYear', { price: money(plan.prices.year) })}
                          </p>
                        )}
                      </>
                    ) : plan.prices.year ? (
                      <p className="text-3xl font-semibold tracking-tight">
                        {t('perYear', { price: money(plan.prices.year) })}
                      </p>
                    ) : null}
                  </div>
                  <ul className="mt-6 flex flex-1 flex-col gap-2.5 text-sm">
                    {features(plan).map((feature) => (
                      <li key={feature} className="flex gap-2">
                        <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <Button
                    asChild
                    className="mt-8 w-full"
                    variant={highlighted ? 'default' : 'outline'}
                  >
                    <Link href={cta.href}>{cta.label}</Link>
                  </Button>
                </li>
              )
            })}
          </ul>
          <p className="mt-10 text-sm text-muted-foreground">
            {t('selfHost')}{' '}
            <a
              href={GETTING_STARTED_URL}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t('selfHostLink')}
            </a>
          </p>
        </section>
      </main>
      <LandingFooter links={getSiteLinks()} pricingEnabled />
    </div>
  )
}
