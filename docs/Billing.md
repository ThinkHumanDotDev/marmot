# Billing and plan entitlements

Marmot is free software and a self-hosted install has **no limits**. The billing code exists so a hosted
offering (or anyone selling Marmot as a service) can meter organizations by plan without forking: it is a
scaffold that is switched off by default and adds nothing to a self-hosted deployment except a few empty
columns on `organizations`.

## How it is switched off

`BILLING_ENABLED=false` (the default) makes `getEntitlements()` return `Infinity` for every limit and `true`
for every feature flag, regardless of the organization's `plan`. The create hooks on monitors, invitations
and status pages return before running a single query, the billing routes answer `501 { "error": "billing
disabled" }` and the **Billing** settings tab is not rendered. Nothing imports the Stripe SDK unless
`STRIPE_SECRET_KEY` is set.

## Environment

| Variable                 | Default | Description                                                                                                                     |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `BILLING_ENABLED`        | `false` | Enforce plan limits and show the Billing tab. Can be on without Stripe (plans are then granted by superadmins in the admin UI). |
| `STRIPE_SECRET_KEY`      | —       | Registers `@payloadcms/plugin-stripe` (webhook endpoint) and enables Checkout / Billing Portal. `sk_test_…` keys are detected.  |
| `STRIPE_WEBHOOK_SECRET`  | —       | Signing secret of the webhook endpoint `POST /api/stripe/webhooks`. Without it the endpoint ignores every event.                |
| `STRIPE_PUBLISHABLE_KEY` | —       | Reserved for a future Stripe Elements checkout; the current flow redirects to Stripe-hosted Checkout and does not need it.      |

`BILLING_ENABLED` is read on the server only. Pages pass the resulting booleans to client components as
props (`SettingsTabs showBilling`), so there is no `NEXT_PUBLIC_BILLING_ENABLED`.

## Plans

Limits live in `PLAN_LIMITS` in `src/lib/entitlements.ts` (client-safe, no I/O). Only `maxMonitors`,
`maxMembers` and `maxStatusPages` are enforced today; the other values are exposed to the UI and the API for
future use (minimum interval, retention and custom domains are not gated yet).

| Plan         | Monitors | Members | Status pages | Min. interval | Retention | Custom domains |
| ------------ | -------: | ------: | -----------: | ------------: | --------: | :------------: |
| `free`       |       10 |       3 |            1 |          60 s |   30 days |       no       |
| `team`       |       50 |      10 |            5 |          30 s |   90 days |      yes       |
| `pro`        |      200 |      50 |           20 |          20 s |  365 days |      yes       |
| `enterprise` |        ∞ |       ∞ |            ∞ |          20 s |         ∞ |      yes       |

`enterprise` cannot be bought through Checkout (`PURCHASABLE_PLANS` is `team` and `pro`); superadmins set
it on the organization in the admin panel. Members and admins cannot change `plan`, `subscriptionStatus`,
`stripeCustomerId` or `stripeSubscriptionId`: those fields are writable by superadmins and by the billing
code (Local API with `overrideAccess: true`) only.

### Effective plan

`effectivePlan(org)` is the plan whose limits apply. A paid plan stays effective while
`subscriptionStatus` is `none` (granted by hand), `trialing`, `active` or `past_due` (grace period) and falls
back to `free` when it is `canceled` or `unpaid`. A downgraded organization keeps everything it has; it just
cannot add more until it is under the limit again.

### Enforcement

`enforceEntitlementOnCreate(resource)` (`src/server/billing/entitlements.ts`) is a `beforeChange` hook on
`monitors` (`monitors`), `invitations` (`members`: current members **plus pending invitations**) and
`status-pages` (`statusPages`). It counts through the Local API inside the request's transaction and throws
a Payload `APIError` with status **402** and
`data: { code: 'entitlement_exceeded', resource, limit, current, plan }`; the message is user-readable
("Your plan allows 10 monitors. Upgrade your plan to add more."). REST, the Local API and the custom route
handlers all surface it unchanged.

Joining through the shareable invite link (`/invite/<code>`) is not metered yet.

## API

All routes require an admin or owner of the organization (`organization:update`) and answer `501` while
billing is disabled.

| Route                                    | Returns                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /api/orgs/:orgId/billing`           | `{ plan, effectivePlan, subscriptionStatus, entitlements, usage, upgrades, hasCustomer, stripeConfigured, … }` |
| `POST /api/orgs/:orgId/billing/checkout` | `{ url }` of a Stripe Checkout session. Body `{ plan: 'team' \| 'pro', interval?: 'month' \| 'year' }`.        |
| `POST /api/orgs/:orgId/billing/portal`   | `{ url }` of a Stripe Billing Portal session.                                                                  |
| `POST /api/stripe/webhooks` (plugin)     | Stripe webhook receiver; signature verified with `STRIPE_WEBHOOK_SECRET`.                                      |

`entitlements` serialises `Infinity` as `null`. Checkout and portal answer `503` when `STRIPE_SECRET_KEY` is
missing or no price matches the plan.

## Running a hosted offering

1. Set `BILLING_ENABLED=true`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
2. In Stripe, create one product per plan with a recurring price (monthly and/or yearly) and put
   `plan=team` / `plan=pro` in the **product or price metadata**. No price ids are configured in Marmot: the
   checkout route lists active recurring prices and picks the one tagged with the requested plan (monthly
   when no interval is requested).
3. Add a webhook endpoint for `https://<your-host>/api/stripe/webhooks` sending
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and
   `customer.deleted`.
4. Admins open **Settings → Billing**, see their usage against the plan and click **Upgrade**; Marmot creates
   a Stripe customer for the organization on demand (name = organization name, email = owner's email,
   metadata `organizationId`) and redirects to Checkout. **Manage billing** opens the Billing Portal, where
   customers change cards, switch plans and cancel.
5. Webhooks map the subscription back to the organization (by `stripeSubscriptionId`, then
   `stripeCustomerId`, then the subscription's `metadata.organizationId` set at checkout) and write `plan`
   (from the price / product / subscription `metadata.plan`) and `subscriptionStatus`. A deleted
   subscription resets the plan to `free` with status `canceled`; a deleted customer clears the Stripe ids.

Renaming an organization updates the Stripe customer's name (`afterChange` hook, best effort).

### Why the Stripe plugin's `sync` option is not used

`@payloadcms/plugin-stripe` can mirror a collection to Stripe customers, but it does so by adding
`stripeID` / `skipSync` fields to the collection **only when the plugin is registered**, which would make the
database schema depend on an environment variable and break the shared migrations. Marmot therefore keeps
explicit `stripeCustomerId` / `stripeSubscriptionId` fields on `organizations` and creates customers itself;
the plugin is used for webhook verification and dispatch.

## Code map

| File                                        | Role                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/lib/entitlements.ts`                   | `PLANS`, `PLAN_LIMITS`, `getEntitlements`, `effectivePlan`, `assertEntitlement`, errors    |
| `src/server/billing/entitlements.ts`        | `isBillingEnabled`, usage counters, `assertOrgEntitlement`, `enforceEntitlementOnCreate`   |
| `src/server/billing/webhooks.ts`            | `stripeWebhookHandlers`, `handleSubscriptionEvent`, `planFromSubscription`                 |
| `src/server/billing/stripe.ts`              | Lazy Stripe client, `ensureStripeCustomer`, `createCheckoutSession`, `createPortalSession` |
| `src/server/billing/overview.ts`            | `getBillingOverview` (settings page + `GET /billing`)                                      |
| `src/server/billing/http.ts`                | Route plumbing: 501 gate, auth, admin check                                                |
| `src/app/api/orgs/[orgId]/billing/**`       | Route handlers                                                                             |
| `src/components/settings/billing-panel.tsx` | Billing tab UI                                                                             |
| `src/plugins/index.ts`                      | Conditional `stripePlugin` registration                                                    |
