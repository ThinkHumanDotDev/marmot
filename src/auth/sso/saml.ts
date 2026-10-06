import { createSaml } from '@thinkhumandotdev/payload-auth/saml'

import { AUTH_ACCOUNTS_SLUG } from '@/collections/AuthAccounts'
import { env } from '@/env'
import type { User } from '@/payload-types'
import {
  connectionEndpoints,
  findEnabledConnection,
  toSamlConnection,
} from '@/server/sso/connections'

import { userResolution } from './hooks'
import { linkErrorResponse, twoFactorResponse } from './oauth'

const serverUrl = () => env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')

/**
 * The SAML 2.0 integration (`@thinkhumandotdev/payload-auth/saml`): every connection is an
 * organization's `sso-connections` row of type `saml`, resolved by slug per request. Routes live
 * under `/api/auth/saml/<slug>/{login,acs,metadata}` (`src/app/api/auth/saml`), rate limited there.
 * The service-provider entity id is the metadata URL, so the IdP can import it directly.
 */
export const saml = createSaml({
  usersSlug: 'users',
  accounts: { slug: AUTH_ACCOUNTS_SLUG },
  basePath: false,
  callbackUrl: (connection) =>
    connectionEndpoints({ slug: connection.id, type: 'saml' }).callbackUrl,
  metadataUrl: (connection) =>
    connectionEndpoints({ slug: connection.id, type: 'saml' }).metadataUrl ??
    `${serverUrl()}/api/auth/saml/${connection.id}/metadata`,
  successRedirect: '/',
  errorRedirect: '/login',
  cookie: { name: 'marmot-saml', path: '/api/auth/saml' },
  connections: {
    get: async (id, { payload }) => {
      const connection = await findEnabledConnection(payload, id)
      return connection?.type === 'saml' ? toSamlConnection(connection) : null
    },
  },
  users: userResolution,
  onError: ({ transaction, code, cookies }) => linkErrorResponse(transaction, code, cookies),
  onAuthenticated: ({ user, next, cookies, linking }) =>
    twoFactorResponse(user as unknown as User, next, cookies, linking),
})
