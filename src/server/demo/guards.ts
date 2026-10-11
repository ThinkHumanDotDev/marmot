/**
 * Demo mode guard rails on the data layer (#159). Applied to every collection and global from the
 * registries (`src/collections/index.ts`, `src/globals/index.ts`), so the Marmot routes, the
 * Payload REST/GraphQL API, the admin panel and the MCP tools all hit the same refusal. Each hook
 * reads `DEMO_MODE` at call time and is a no-op outside demo mode or for the reset's own writes
 * (`DEMO_SEED_CONTEXT`).
 *
 * Route-level refusals for actions that have no collection behind them (imports, the SMTP test,
 * billing, Docker host tests, two-factor setup, first-run setup) call `assertDemoAllows` directly.
 */
import type {
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  CollectionConfig,
  GlobalBeforeChangeHook,
  GlobalConfig,
} from 'payload'

import { assertDemoAllows, type DemoFeature, isDemoMode, isDemoSeedRequest } from './config'

/** Collections that cannot be written at all in demo mode, and the feature they belong to. */
export const DEMO_LOCKED_COLLECTIONS: Readonly<Record<string, DemoFeature>> = {
  // Organization API keys (#224): a key outlives the reset's session cookies and could script abuse.
  'api-keys': 'apiKeys',
  // Outbound webhooks (#228): arbitrary URLs the instance would POST to.
  'webhook-endpoints': 'webhooks',
  // Single sign-on: identity provider URLs the server would call, and SSO enforcement locks out.
  'sso-connections': 'sso',
  'sso-domains': 'sso',
  // Uploads (#248 routes and the Payload upload API): no user files on a public demo.
  media: 'uploads',
}

const WRITE_OPERATIONS = new Set(['create', 'update', 'updateByID'])

const refuseWrites =
  (feature: DemoFeature): CollectionBeforeOperationHook =>
  ({ operation, req }) => {
    if (WRITE_OPERATIONS.has(operation)) assertDemoAllows(feature, req)
  }

/**
 * Demo credentials stay usable for every visitor: no password or email change, no password reset,
 * no account deletion. (Two-factor setup is refused by its route; signups by `isSignupAllowed`.)
 */
const protectAccountOperations: CollectionBeforeOperationHook = ({ operation, req }) => {
  if (operation === 'forgotPassword' || operation === 'resetPassword' || operation === 'delete') {
    assertDemoAllows('accountCredentials', req)
  }
}

const protectAccountCredentials: CollectionBeforeChangeHook = ({
  data,
  originalDoc,
  operation,
  req,
}) => {
  if (operation !== 'update' || !isDemoMode() || isDemoSeedRequest(req)) return data
  const emailChanged =
    typeof data?.email === 'string' &&
    data.email.trim().toLowerCase() !== String(originalDoc?.email ?? '').toLowerCase()
  if (data?.password || emailChanged) assertDemoAllows('accountCredentials', req)
  return data
}

/** Enforcing single sign-on would lock the demo account out of its own organization. */
const refuseSsoEnforcement: CollectionBeforeChangeHook = ({ data, originalDoc, req }) => {
  if (data?.enforceSso === true && originalDoc?.enforceSso !== true) assertDemoAllows('sso', req)
  return data
}

/** Custom status page domains would make the demo serve pages on hosts it does not own. */
const refuseCustomDomains: CollectionBeforeChangeHook = ({ data, originalDoc, req }) => {
  if (!Array.isArray(data?.domains)) return data
  const hosts = (rows: unknown) =>
    (Array.isArray(rows) ? rows : [])
      .map((row) => String((row as { hostname?: unknown })?.hostname ?? '').toLowerCase())
      .sort()
      .join(',')
  if (data.domains.length > 0 && hosts(data.domains) !== hosts(originalDoc?.domains)) {
    assertDemoAllows('customDomains', req)
  }
  return data
}

const FIELD_GUARDS: Readonly<Record<string, CollectionBeforeChangeHook>> = {
  users: protectAccountCredentials,
  organizations: refuseSsoEnforcement,
  'status-pages': refuseCustomDomains,
}

/** Adds the demo mode hooks a collection needs (most need none). */
export function withDemoGuards(collection: CollectionConfig): CollectionConfig {
  const locked = DEMO_LOCKED_COLLECTIONS[collection.slug]
  const fieldGuard = FIELD_GUARDS[collection.slug]
  const operationGuard =
    collection.slug === 'users' ? protectAccountOperations : locked ? refuseWrites(locked) : null
  if (!operationGuard && !fieldGuard) return collection
  return {
    ...collection,
    hooks: {
      ...collection.hooks,
      // First, so a refused request never reaches the rate limits, validation or side effects.
      beforeOperation: [
        ...(operationGuard ? [operationGuard] : []),
        ...(collection.hooks?.beforeOperation ?? []),
      ],
      beforeChange: [
        ...(fieldGuard ? [fieldGuard] : []),
        ...(collection.hooks?.beforeChange ?? []),
      ],
    },
  }
}

/** Instance settings (signup, SMTP-related defaults, base URL…) are read-only in demo mode. */
const refuseGlobalWrites: GlobalBeforeChangeHook = ({ data, req }) => {
  assertDemoAllows('instanceSettings', req)
  return data
}

export function withDemoGlobalGuards(global: GlobalConfig): GlobalConfig {
  return {
    ...global,
    hooks: {
      ...global.hooks,
      beforeChange: [refuseGlobalWrites, ...(global.hooks?.beforeChange ?? [])],
    },
  }
}
