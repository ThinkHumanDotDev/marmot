# Single sign-on (OIDC)

Marmot can authenticate users against any OpenID Connect provider that supports discovery and the
authorization code flow with PKCE: Keycloak, Authentik, Zitadel, Okta, Microsoft Entra ID, Google
Workspace, Dex, … Local password login stays available next to SSO.

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

`GET /api/auth/providers` returns `{ "local": true, "oidc": { "enabled": true, "displayName": "…" } }`
once the three required variables are set; the login page renders the SSO button from it.

Plain `http://` issuers are accepted only when `NODE_ENV` is not `production` (local Keycloak,
tests). Production providers must use HTTPS.

## How users are matched

On every successful login Marmot verifies the ID token (signature, issuer, audience, `nonce`) and
reads the UserInfo endpoint, then:

1. looks for a user with the same `(oidcIssuer, oidcSubject)` — the stable `sub` claim;
2. otherwise looks for a user with the same email address. The account is linked (subject recorded)
   only if the provider asserts `email_verified: true`; an unverified email never takes over an
   existing account (`/login?error=email_unverified`);
3. otherwise, with `OIDC_AUTO_PROVISION=true`, creates the user with the claims' name, a random
   password nobody knows and `authProvider: oidc`. With `DISABLE_SIGNUP=true` this requires a pending
   invitation for that email; the invitation is accepted so the user lands in the organization.

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

Signing out (`POST /api/auth/oidc/logout`, used by the account menu for SSO sessions) revokes the Payload
session and clears the cookie. When the provider advertises an `end_session_endpoint` the browser is sent
there with `post_logout_redirect_uri=${NEXT_PUBLIC_SERVER_URL}/login` so the provider session ends too
(register that URI at the provider); otherwise the browser goes straight to `/login`.

## Troubleshooting

- `/login?error=oidc_state` — the browser returned without (or with a stale) `marmot-oidc` cookie:
  the login took longer than 10 minutes, cookies are blocked, or `NEXT_PUBLIC_SERVER_URL` does not
  match the URL you opened Marmot at.
- `/login?error=oidc_failed` — token exchange or ID-token validation failed. The web process log
  (`module: "oidc"`) has the provider's error; typical causes are a redirect URI mismatch, a wrong
  client secret or an issuer URL that differs from the `iss` claim (trailing slash!). Marmot
  rediscovers the provider configuration after such an error, so rotated keys are picked up on
  the next attempt.
- `/login?error=email_missing` — the provider did not release an email. Add the `email` scope or a
  claim mapper.
- `/login?error=signup_disabled` — `DISABLE_SIGNUP=true` and no pending invitation exists for the
  user's email. Invite them first.
- `/login?error=provisioning_disabled` — `OIDC_AUTO_PROVISION=false` and no account exists yet.
