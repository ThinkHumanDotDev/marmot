# Single sign-on

Marmot can authenticate users against any OpenID Connect provider that supports discovery and the
authorization code flow with PKCE (Keycloak, Authentik, Zitadel, Okta, Microsoft Entra ID, Google
Workspace, Dex, …) and offers **Sign in with GitHub** and **Sign in with Google** buttons. Local password
login stays available next to SSO, and a user can link several identities to one account.

## Configuration

Set the three variables below and restart the web process. Nothing else is needed; the provider's
endpoints and signing keys are read from `<OIDC_ISSUER_URL>/.well-known/openid-configuration`.

| Variable              | Default                | Description                                                                                                                    |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `OIDC_ISSUER_URL`     | —                      | Issuer identifier, exactly as the provider advertises it (`iss` claim).                                                        |
| `OIDC_CLIENT_ID`      | —                      | Client / application id registered at the provider.                                                                            |
| `OIDC_CLIENT_SECRET`  | —                      | Confidential client secret.                                                                                                    |
| `OIDC_DISPLAY_NAME`   | `Single sign-on`       | Label of the login button: "Continue with _name_".                                                                             |
| `OIDC_SCOPES`         | `openid email profile` | Scopes to request. Keep `openid email`; add provider-specific scopes if your IdP needs them to release the email.              |
| `OIDC_AUTO_PROVISION` | `true`                 | Create a Marmot account on first login. With `false`, only users that already exist (by subject or verified email) can log in. |
| `DISABLE_SIGNUP`      | `false`                | When `true`, auto-provisioning only creates accounts for emails with a **pending invitation**, which is accepted on login.     |

Register this **redirect URI** at the provider (must match `NEXT_PUBLIC_SERVER_URL` exactly):

```
${NEXT_PUBLIC_SERVER_URL}/api/auth/oidc/callback
```

and, for RP-initiated logout, this **post-logout redirect URI**:

```
${NEXT_PUBLIC_SERVER_URL}/login
```

`GET /api/auth/providers` returns `{ "local": true, "oidc": { "enabled": true, "displayName": "…" }, "providers": [ { "id": "oidc", "name": "…", "type": "oidc", "loginPath": "/api/auth/sso/oidc/login" } ] }`
once the three required variables are set; the login page renders one button per entry of `providers`.
The env-configured client has the id `oidc`; its flow starts at `/api/auth/sso/oidc/login` (the older
`/api/auth/oidc/login` keeps working) and its redirect URI stays `/api/auth/oidc/callback`.

Plain `http://` issuers are accepted only when `NODE_ENV` is not `production` (local Keycloak,
tests). Production providers must use HTTPS.

## Sign in with GitHub and Google

Each pair of variables enables a button on the login page; both can be combined with the OIDC client.

| Variable                                   | Where to get it                                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**. Authorization callback URL: `${NEXT_PUBLIC_SERVER_URL}/api/auth/sso/github/callback`.                   |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud console → **APIs & Services → Credentials → OAuth client ID** (Web application). Authorised redirect URI: `${NEXT_PUBLIC_SERVER_URL}/api/auth/sso/google/callback`. |

GitHub releases the primary **verified** email (scope `user:email`); Google asserts `email_verified`. Both
therefore link to an existing account with the same email, as described below. New accounts created through
them get `authProvider: oauth`. The sign-up rules are the same as for the OIDC client: with `DISABLE_SIGNUP`
a pending invitation is required.

## Connected accounts

**Settings → Account → Connected accounts** lists the identities linked to the signed-in user with the
provider, email and last use. **Link GitHub / Google / …** starts the provider's flow with `link=1` and
attaches the identity to the current account (an identity already linked to somebody else is refused with
`account_in_use` and the page shows why). **Unlink** removes an identity; an account created through single
sign-on, which has no password of its own, cannot unlink its last identity.

## How users are matched

On every successful login Marmot verifies the ID token (signature, issuer, audience, `nonce`) and
reads the UserInfo endpoint (or, for GitHub, the user and e-mail APIs), then:

1. looks for a **linked account** with the same provider and `sub` claim (the `auth-accounts`
   collection, _Access → Auth accounts_ in the admin panel). A user can hold several linked identities;
2. otherwise, for users created before Marmot 0.2, matches the legacy `oidcIssuer`/`oidcSubject` fields
   on the user and creates the linked account from them;
3. otherwise looks for a user with the same email address. The identity is linked only if the provider
   asserts `email_verified: true`; an unverified email never takes over an existing account
   (`/login?error=email_unverified`);
4. otherwise, with `OIDC_AUTO_PROVISION=true`, creates the user with the claims' name, a random
   password nobody knows and `authProvider: oidc`, and links the identity. With `DISABLE_SIGNUP=true`
   this requires a pending invitation for that email; the invitation is accepted so the user lands in
   the organization.

The session that results is a regular Payload session (`payload-token` cookie, same expiry as
password logins). Signing out an SSO user also redirects to the provider's `end_session_endpoint`
when it advertises one.

Users created through SSO can still request a password reset by email if you want them to have a
local password as well. Linked accounts keep their existing password.

## Keycloak

1. In your realm open **Clients → Create client**: type _OpenID Connect_, client id `marmot`, click
   Next, enable **Client authentication**, keep **Standard flow** checked (disable the others), Next.
2. **Valid redirect URIs**: `https://status.example.com/api/auth/oidc/callback`.
   **Valid post logout redirect URIs**: `https://status.example.com/login`. Save.
3. Copy the secret from the **Credentials** tab.
4. (Optional) **Advanced → Proof Key for Code Exchange Code Challenge Method**: `S256` to require PKCE.
5. Make sure users have a verified email (**Users → Email verified**) or linking to existing accounts
   is refused.

```env
OIDC_ISSUER_URL=https://keycloak.example.com/realms/main
OIDC_CLIENT_ID=marmot
OIDC_CLIENT_SECRET=<secret from the Credentials tab>
OIDC_DISPLAY_NAME=Keycloak
```

## Authentik

1. **Applications → Providers → Create**: _OAuth2/OpenID Provider_. Name `Marmot`, authorization
   flow _explicit consent_ (or implicit), **Client type** _Confidential_, note the client id and
   secret.
2. **Redirect URIs/Origins**: `https://status.example.com/api/auth/oidc/callback` (strict).
3. Under **Advanced protocol settings** keep the `openid`, `email` and `profile` scopes selected,
   subject mode _Based on the User's hashed ID_ (default) and signing key _authentik Self-signed_.
4. **Applications → Create**: name `Marmot`, slug `marmot`, pick the provider.
5. The issuer is shown on the provider page as _OpenID Configuration Issuer_
   (`https://authentik.example.com/application/o/marmot/`). Note the trailing slash.

```env
OIDC_ISSUER_URL=https://authentik.example.com/application/o/marmot/
OIDC_CLIENT_ID=<client id>
OIDC_CLIENT_SECRET=<client secret>
OIDC_DISPLAY_NAME=Authentik
```

## Microsoft Entra ID

1. **Entra ID → App registrations → New registration**: name `Marmot`, supported account types _Single
   tenant_ (or multi-tenant if you need it), platform **Web**, redirect URI
   `https://status.example.com/api/auth/oidc/callback`.
2. **Authentication**: add `https://status.example.com/login` under _Front-channel logout URL_ (optional)
   and keep _ID tokens_ unchecked (the authorization code flow does not need implicit grants).
3. **Certificates & secrets → New client secret**; copy the **value** (not the id).
4. **API permissions**: `openid`, `email`, `profile` (Microsoft Graph delegated) are granted by default.
   If your tenant restricts user consent, grant admin consent once.
5. **Token configuration → Add optional claim → ID → `email`** so users without a mailbox still release an
   email. Entra ID does not emit `email_verified`, so Marmot will **not** link an SSO login to an existing
   password account by email (`/login?error=email_unverified`); it matches returning users by subject and
   provisions new ones. For people who already have a password account, a superadmin can set
   `oidcIssuer`/`oidcSubject` on their user in the admin panel, or they keep using the password.
6. The issuer is `https://login.microsoftonline.com/<tenant-id>/v2.0` (from **Overview → Endpoints →
   OpenID Connect metadata document**, without the `/.well-known/...` suffix).

```env
OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<application (client) id>
OIDC_CLIENT_SECRET=<client secret value>
OIDC_DISPLAY_NAME=Microsoft
```

## Other providers

Any provider with a discovery document works the same way: register a confidential web client with the
callback URI, copy issuer, client id and secret. Known-good issuer shapes:

| Provider         | `OIDC_ISSUER_URL`                                        |
| ---------------- | -------------------------------------------------------- |
| Zitadel          | `https://<instance>.zitadel.cloud`                       |
| Okta             | `https://<org>.okta.com` (or `/oauth2/<server-id>`)      |
| Google Workspace | `https://accounts.google.com`                            |
| Dex              | `https://dex.example.com` (the `issuer` from its config) |
| Auth0            | `https://<tenant>.auth0.com/`                            |

## Auto-provisioning and invitations

With `OIDC_AUTO_PROVISION=true` (default) the first SSO login creates the Marmot account. New accounts have
no organization yet and land on `/onboarding` to create one; an invitation link received by email can be
opened afterwards to join an existing organization. Operators who want SSO users to join **only** by
invitation set `DISABLE_SIGNUP=true`: provisioning then requires a pending invitation for the email, that
invitation is accepted during the login, and the user lands directly in the invited organization with the
invited role; uninvited emails are refused with `signup_disabled`.

## Logout

Signing out (`POST /api/auth/sso/logout`, used by the account menu for SSO sessions; `/api/auth/oidc/logout`
is an alias) revokes the Payload session and clears the cookie. When the provider advertises an `end_session_endpoint` the browser is sent
there with `post_logout_redirect_uri=${NEXT_PUBLIC_SERVER_URL}/login` so the provider session ends too
(register that URI at the provider); otherwise the browser goes straight to `/login`.

## Troubleshooting

- `/login?error=state_mismatch` — the browser returned without (or with a stale) `marmot-sso` cookie:
  the login took longer than 10 minutes, cookies are blocked, or `NEXT_PUBLIC_SERVER_URL` does not
  match the URL you opened Marmot at.
- `/login?error=exchange_failed` — token exchange or ID-token validation failed. The web process log
  (`payload-auth:` messages) has the provider's error; typical causes are a redirect URI mismatch, a
  wrong client secret or an issuer URL that differs from the `iss` claim (trailing slash!). Marmot
  rediscovers the provider configuration after such an error, so rotated keys are picked up on
  the next attempt.
- `/login?error=access_denied` — the identity provider refused the request (the user cancelled, or a
  policy at the provider).
- `/login?error=provider_unknown` — the provider in the URL is not configured on this server.
- `/login?error=email_missing` — the provider did not release an email. Add the `email` scope or a
  claim mapper.
- `/login?error=signup_disabled` — `DISABLE_SIGNUP=true` and no pending invitation exists for the
  user's email. Invite them first.
- `/login?error=provisioning_disabled` — `OIDC_AUTO_PROVISION=false` and no account exists yet.

## Under the hood

The protocol work lives in [`@thinkhumandotdev/payload-auth`](https://github.com/ThinkHumanDotDev/payload-plugin-auth),
a reusable set of Payload plugins (OAuth 2.0 / OpenID Connect and SAML 2.0) maintained alongside Marmot.
`src/auth/sso` configures it: providers are resolved per request (today from the `OIDC_*` variables), the
routes under `/api/auth/{oidc,sso}` are Marmot's own so they share its rate limiting, and the hooks add
Marmot's rules (invitations, `DISABLE_SIGNUP`, the two-factor hand-off, the legacy column match). Linked
identities are rows of the `auth-accounts` collection.
