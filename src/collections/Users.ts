import {
  type CollectionBeforeDeleteHook,
  type CollectionBeforeLoginHook,
  type CollectionConfig,
  type FieldAccess,
} from 'payload'

import { authenticated, selfOrSuperadmin, superadminOnly } from '@/access/org-scoped'
import { isSuperadmin, type UserLike } from '@/access/permissions'
import { AUTH_ACCOUNTS_SLUG } from '@/collections/AuthAccounts'
import { adminGroup, adminT } from '@/i18n/admin'
import { defaultLocale, localeNames, locales } from '@/i18n/locales'
import {
  auditAuthFailure,
  auditLogin,
  rateLimitAuthOperations,
  TWO_FACTOR_GATE_CONTEXT,
} from '@/server/security/auth-hooks'
import {
  applyEmailVerificationState,
  flagClientUserWrite,
  sendVerificationOnChange,
} from '@/server/auth/email-verification'
import { refusePasswordLogin, refusePasswordReset } from '@/server/sso/local-login'
import { isSignupAllowed } from '@/server/settings'
import { apiError } from '@/server/errors'

const superadminField: FieldAccess = ({ req }) => isSuperadmin(req.user)
/** Server-owned: written with `overrideAccess: true` only, never readable through the API. */
const serverOnlyField = {
  read: () => false,
  create: () => false,
  update: () => false,
} satisfies Record<string, FieldAccess>

/**
 * How an account was created: password signup (`local`), the env-configured OpenID Connect client
 * (`oidc`), a social OAuth provider such as GitHub or Google (`oauth`) or a SAML identity provider
 * (`saml`), or an email sign-in link (`magic-link`, #164). Accounts created through single sign-on
 * or a sign-in link have a random password nobody knows; see `hasPassword`.
 */
export const AUTH_PROVIDERS = ['local', 'oidc', 'oauth', 'saml', 'magic-link'] as const
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]

/** `true` for accounts that chose their own password (and can be asked for it). */
export const hasPassword = (
  user: { authProvider?: AuthProvider | null } | null | undefined,
): boolean => !user?.authProvider || user.authProvider === 'local'

export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

/** `req.context` flag with which Marmot's own login flow (`src/auth/two-factor`) calls `payload.login`. */
export { TWO_FACTOR_GATE_CONTEXT }

/**
 * Payload's own login (`POST /api/users/login`, `payload.login`) issues a session as soon as the
 * password matches. Accounts with two-factor authentication must go through
 * `POST /api/auth/login` → `POST /api/auth/2fa` instead, which call `payload.login` with the
 * gate flag in `req.context` and withhold the session until the code is verified.
 */
const requireTwoFactorGate: CollectionBeforeLoginHook = ({ user, context }) => {
  if (user?.twoFactorEnabled === true && context?.[TWO_FACTOR_GATE_CONTEXT] !== true) {
    throw apiError('twoFactorUseLoginPage', 401)
  }
  return user
}

/**
 * Linked single sign-on identities reference the user with a NOT NULL foreign key on Postgres, so
 * they have to go before the user row does (and an identity must never survive its user anyway).
 */
const removeAuthAccounts: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await req.payload.delete({
    collection: AUTH_ACCOUNTS_SLUG,
    where: { user: { equals: id } },
    depth: 0,
    req,
    overrideAccess: true,
  })
}

/**
 * Who may create a user. Superadmins always can; anyone (including anonymous visitors on the
 * signup page, which posts to `POST /api/users`) can while signup is allowed: the
 * `instance-settings` global's `allowSignup`, which defaults to `!DISABLE_SIGNUP`. Invitation
 * acceptance for an existing account does not create users; a future invite-signup flow creates
 * them server-side with `overrideAccess: true`.
 */
export const canSignUp = (user: UserLike | null | undefined, disableSignup: boolean): boolean =>
  isSuperadmin(user) || !disableSignup

/**
 * Payload-native auth users. Organization memberships (`organizations[]` with `organization` and
 * `role`) are added by `@payloadcms/plugin-multi-tenant` in `src/plugins/index.ts`; only
 * superadmins may edit that array directly, everyone else joins through invitations.
 */
export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
    group: adminGroup('access'),
    defaultColumns: ['email', 'name', 'superadmin'],
  },
  auth: true,
  access: {
    // Only instance administrators get the Payload admin panel; everyone else uses the Marmot UI.
    admin: ({ req }) => Boolean(req.user?.superadmin),
    // Anonymous creation is allowed for signup; field-level access below (and the multi-tenant
    // plugin's access on `organizations`) strips `superadmin` and memberships from such requests.
    create: async ({ req }) => canSignUp(req.user, !(await isSignupAllowed(req.payload))),
    read: authenticated, // the multi-tenant plugin narrows this to users who share an organization
    update: selfOrSuperadmin,
    delete: superadminOnly,
  },
  hooks: {
    // Rate limits `login` / `forgot-password` (REST only) and records the attempts in `audit-logs`.
    // Then the password policy (SSO-only mode, organization enforcement) refuses resets.
    // `flagClientUserWrite` + `applyEmailVerificationState` + `sendVerificationOnChange`: optional
    // email verification of self-service sign-ups (src/server/auth/email-verification.ts).
    beforeOperation: [rateLimitAuthOperations, refusePasswordReset, flagClientUserWrite],
    beforeChange: [applyEmailVerificationState],
    afterChange: [sendVerificationOnChange],
    beforeLogin: [refusePasswordLogin, requireTwoFactorGate],
    beforeDelete: [removeAuthAccounts],
    afterLogin: [auditLogin],
    afterError: [auditAuthFailure],
  },
  fields: [
    // email + password are added by `auth: true`
    {
      name: 'name',
      type: 'text',
    },
    {
      name: 'avatar',
      type: 'upload',
      relationTo: 'media',
    },
    {
      name: 'superadmin',
      type: 'checkbox',
      defaultValue: false,
      saveToJWT: true,
      access: {
        create: superadminField,
        update: superadminField,
      },
      admin: {
        description: adminT('marmot:users:superadminDescription'),
      },
    },
    // Email verification (#177). `true` by default, so accounts from before the setting existed,
    // the setup wizard, invitations and server code are verified; only a self-service sign-up made
    // while `requireEmailVerification` is on starts as `false` (src/server/auth/email-verification.ts).
    {
      name: 'emailVerified',
      type: 'checkbox',
      defaultValue: true,
      access: {
        create: superadminField,
        update: superadminField,
      },
      admin: {
        position: 'sidebar',
        description: adminT('marmot:users:emailVerifiedDescription'),
      },
    },
    {
      name: 'emailVerifiedAt',
      type: 'date',
      access: {
        create: superadminField,
        update: superadminField,
      },
      admin: { position: 'sidebar', readOnly: true },
    },
    // Single sign-on (src/auth/sso). Set server-side with `overrideAccess`; clients can never write
    // them, so a signup POST cannot claim somebody else's identity.
    {
      name: 'authProvider',
      type: 'select',
      defaultValue: 'local',
      options: AUTH_PROVIDERS.map((provider) => ({ label: provider, value: provider })),
      access: {
        create: superadminField,
        update: superadminField,
      },
      admin: {
        position: 'sidebar',
        description: adminT('marmot:users:authProviderDescription'),
      },
    },
    // Legacy OIDC identity, from before linked identities moved to the `auth-accounts` collection.
    // Still matched by the login flow (`src/auth/sso/oauth.ts`, `findUser`) so existing users keep
    // signing in; an account row is created on their next login. Dropped in a future release.
    {
      name: 'oidcIssuer',
      type: 'text',
      access: {
        create: superadminField,
        update: superadminField,
      },
      admin: {
        position: 'sidebar',
        readOnly: true,
        description: adminT('marmot:users:oidcIssuerDescription'),
      },
    },
    {
      name: 'oidcSubject',
      type: 'text',
      unique: true,
      index: true,
      access: {
        create: superadminField,
        update: superadminField,
      },
      admin: {
        position: 'sidebar',
        readOnly: true,
        description: adminT('marmot:users:oidcSubjectDescription'),
      },
    },
    {
      name: 'theme',
      type: 'select',
      defaultValue: 'system',
      options: THEMES.map((theme) => ({ label: theme, value: theme })),
      admin: {
        position: 'sidebar',
        description: adminT('marmot:users:themeDescription'),
      },
    },
    // Marmot UI locale (src/i18n). Resolved before the `marmot-locale` cookie and `Accept-Language`.
    {
      name: 'language',
      type: 'select',
      label: adminT('marmot:language'),
      defaultValue: defaultLocale,
      options: locales.map((locale) => ({ label: localeNames[locale], value: locale })),
      admin: {
        position: 'sidebar',
        description: adminT('marmot:userLanguageDescription'),
      },
    },
    // Two-factor authentication (src/auth/two-factor). The flag is readable so the UI and the
    // login flow know whether a code is required; the secret material is written server-side only
    // and never leaves the database through the API (`hidden` + read access `false`).
    {
      name: 'twoFactorEnabled',
      type: 'checkbox',
      defaultValue: false,
      access: {
        create: () => false,
        update: () => false,
      },
      admin: {
        position: 'sidebar',
        readOnly: true,
        description: adminT('marmot:users:twoFactorEnabledDescription'),
      },
    },
    {
      name: 'twoFactorVerifiedAt',
      type: 'date',
      access: {
        create: () => false,
        update: () => false,
      },
      admin: { position: 'sidebar', readOnly: true },
    },
    {
      // AES-256-GCM sealed TOTP secret (`src/auth/two-factor/crypto.ts`).
      name: 'twoFactorSecret',
      type: 'text',
      hidden: true,
      access: serverOnlyField,
    },
    {
      // Sealed secret of a setup that has not been confirmed with a code yet.
      name: 'twoFactorPendingSecret',
      type: 'text',
      hidden: true,
      access: serverOnlyField,
    },
    {
      // HMAC digests of the unused backup codes.
      name: 'twoFactorBackupCodes',
      type: 'json',
      hidden: true,
      access: serverOnlyField,
    },
    {
      // Time step of the last accepted TOTP code; codes at or before it are replays.
      name: 'twoFactorLastUsedStep',
      type: 'number',
      hidden: true,
      access: serverOnlyField,
    },
  ],
}
