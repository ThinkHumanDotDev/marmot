# Single sign-on

Marmot can authenticate users against any OpenID Connect provider that supports discovery and the
authorization code flow with PKCE (Keycloak, Authentik, Zitadel, Okta, Microsoft Entra ID, Google
Workspace, Dex, …) and offers **Sign in with GitHub** and **Sign in with Google** buttons. Local password
login stays available next to SSO unless you turn on the [SSO-only mode](#sso-only-mode), and a user can
link several identities to one account. Identity-provider [groups](#groups-allow-list-and-role-mapping)
can restrict who may sign in and decide organization memberships and roles.

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

## Groups: allow-list and role mapping

The OIDC client can read the user's groups from the ID token / UserInfo response and use them to decide
who may sign in and which organizations and roles they get. All variables are optional; without them every
user the identity provider authenticates may sign in, as before.

| Variable                   | Default  | Description                                                                                                                                                                            |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OIDC_GROUP_CLAIM`         | `groups` | Claim that lists the groups. A dotted path reads nested claims (Keycloak realm roles: `realm_access.roles`). The value may be a list, a string or a comma-separated string.            |
| `OIDC_ALLOWED_GROUPS`      | —        | Comma-separated, case-insensitive. When set, only members of at least one of these groups can sign in **or be provisioned**; everybody else lands on `/login?error=group_not_allowed`. |
| `OIDC_ROLE_MAPPING`        | —        | JSON object from group to organization role (see below). Applied on **every** login.                                                                                                   |
| `OIDC_ROLE_MAPPING_REMOVE` | `false`  | Also remove memberships (and superadmin) that the user's groups no longer grant.                                                                                                       |

```env
OIDC_ALLOWED_GROUPS=marmot-users,platform-admins,sre
OIDC_ROLE_MAPPING={"platform-admins": {"org": "acme", "role": "admin"}, "sre": [{"org": "acme", "role": "member"}, {"org": "ops", "role": "viewer"}], "marmot-admins": {"role": "superadmin"}}
```

Keys are group names (case-insensitive). A value is one rule or a list of rules: `{"org": "<organization slug>", "role":
"owner" | "admin" | "member" | "viewer"}`, or `{"role": "superadmin"}` for the instance role. An invalid mapping stops
the server at startup with a message naming the problem. Groups that are not in the mapping (such as `marmot-users`
above) only matter for the allow-list.

On every login through the OIDC client Marmot:

1. **checks the allow-list** before it provisions or links an account and again on every later login, so a user removed
   from the allowed groups at the identity provider can no longer sign in. A token without the group claim is refused with
   `/login?error=groups_missing` while an allow-list is set. Refusals are written to the audit log as
   `auth.sso_group_denied` with the email, the reason and the groups the provider sent;
2. **applies the mapping**: per organization the highest role among the user's matching groups wins. A user who is not a
   member yet is added (`member.added`), a member with a different role is moved to the mapped one, up or down
   (`member.role_changed`). A matching superadmin rule grants superadmin (`user.superadmin_granted`);
3. with `OIDC_ROLE_MAPPING_REMOVE=true`, **removes** memberships of organizations the mapping names when none of the user's
   groups maps to them any more (`member.removed`) and revokes superadmin when no superadmin group matches
   (`user.superadmin_revoked`). Organizations the mapping does not name are never touched, so people can still be invited
   to them by hand.

Rules that protect organizations and the instance:

- **The last owner is never demoted or removed.** If the mapping would demote or remove the only owner of an
  organization, the change is skipped and recorded as `member.sync_skipped` (reason `last_owner`); it applies on a later
  login once the organization has another owner (transfer ownership or map a second owner).
- **The last superadmin keeps superadmin**, even with removal on (`user.sync_skipped`, reason `last_superadmin`).
- A token **without** the group claim leaves memberships alone, even with removal on, so a provider that stops releasing
  the claim cannot strip everybody's access. Make sure the client is allowed to see the claim (see the provider notes
  below).
- Organizations are referenced by slug; a slug that does not exist is ignored with a warning in the web log.

Every mapping decision is written to the audit log with the provider as the actor (actor type _system_,
`sso:oidc`), the organization, the role before and after and the groups the provider sent. The mapping only applies to
the OIDC client: GitHub and Google send no groups and are not subject to the allow-list, so leave them unconfigured if the
allow-list must cover everybody.

**Provider notes.** Keycloak: add a _Group Membership_ mapper (token claim name `groups`, _Full group path_ off) to the
client's dedicated scope, or use realm roles with `OIDC_GROUP_CLAIM=realm_access.roles`. Authentik releases `groups` with
the `profile` scope. Microsoft Entra ID: **Token configuration → Add groups claim**; Entra sends group **object ids**, so
use those ids as group names (or emit `sAMAccountName` for synced groups). Okta: add a `groups` claim with a filter to the
authorization server and request the `groups` scope (`OIDC_SCOPES=openid email profile groups`).

## SSO-only mode

`OIDC_DISABLE_LOCAL_LOGIN=true` makes the identity provider the only way in:

- the login page hides the password form (and the sign-up link) and only shows the single sign-on buttons;
- password logins are refused with 403 on `POST /api/auth/login`, `POST /api/users/login` and the Local API;
- sign-ups are disabled (`allowSignup` is ignored) and `POST /api/users/forgot-password` and
  `POST /api/users/reset-password` answer 403;
- [email sign-in links](Organizations-and-Members.md#sign-in-links-passwordless) count as a local login and
  are off (`POST /api/auth/magic-link` and links already sent answer 403), break-glass included;
- `GET /api/auth/providers` reports `"local": false`.

**Break-glass.** With `OIDC_BREAK_GLASS=true` a **superadmin** can still sign in with their password at
`/login?local=1` (the form posts to `/api/auth/login?local=1`; `POST /api/users/login?local=1` works too). Every
such login is written to the audit log as `auth.break_glass` (scope `instance`). The Payload admin panel's own
login form does not send `local=1`; sign in at `/login?local=1` first and then open `/admin`. The same page links to
`/forgot-password?local=1`, which accepts any email but only mails superadmins (the answer is the same for everyone, so
it does not reveal who is one), and the reset link only works for superadmins. Without `OIDC_BREAK_GLASS`, nobody can
use a password; recover with SSO or by setting the variable and restarting.

To bootstrap a new instance in SSO-only mode, map an IdP group to `{"role": "superadmin"}` so the first administrator
gets the role on their first login, or create the superadmin with a password before turning the mode on and keep
break-glass enabled.

| Variable                   | Default | Description                                                                                                   |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `OIDC_DISABLE_LOCAL_LOGIN` | `false` | Turn off password logins, sign-ups and password resets for the whole instance.                                |
| `OIDC_BREAK_GLASS`         | `false` | With `OIDC_DISABLE_LOCAL_LOGIN`, let superadmins sign in with their password from `/login?local=1` (audited). |

Organizations can additionally require single sign-on for their own verified domains (see _Enforcement_ below); both
apply, and an organization's owners keep their own break-glass path there.

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

## Per-organization connections (hosted and multi-team installs)

Besides the instance-wide providers above, every organization can bring its own identity provider under
**Settings → Security** (owners manage, admins can view; permissions `sso:manage` / `sso:read`). A
_connection_ is one OpenID Connect or SAML 2.0 identity provider:

| Setting                      | OpenID Connect                                                | SAML 2.0                                                                                                  |
| ---------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| What you enter               | Issuer URL, client id, client secret (sealed at rest), scopes | IdP single sign-on URL, IdP entity id, IdP signing certificate (or import them from the IdP metadata URL) |
| What you register at the IdP | Redirect URI `…/api/auth/sso/<slug>/callback`                 | SP entity id / metadata URL `…/api/auth/saml/<slug>/metadata`, ACS URL `…/api/auth/saml/<slug>/acs`       |
| Login starts at              | `/api/auth/sso/<slug>/login`                                  | `/api/auth/saml/<slug>/login` (IdP-initiated logins are accepted only when enabled on the connection)     |
| Signature / validation       | ID token signature, issuer, audience, `nonce`, PKCE           | Assertion (and/or response) signature, audience, validity window, `InResponseTo`, issuer                  |

**Provisioning.** The organization's identity provider vouches for its users, so no invitation is needed:
with _Create accounts on first login_ on (default), a new user is created on first login; everyone who
signs in through the connection joins the organization with the connection's _default role_ (member by
default) unless they are a member already. An existing Marmot user whose email the connection asserts is
linked to it when the provider marks the email verified (OIDC `email_verified`, SAML always) **or** when
the organization has verified that email's domain.

**Groups.** A connection can use the identity provider's groups too (_Groups_ in the connection dialog, or the
`groupClaim`, `allowedGroups` and `groupRoles` fields of the API): the claim (OIDC) or attribute (SAML, for example
`memberOf` or `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups`) that lists the groups, default
`groups`; a comma-separated allow-list (users outside it are refused with `group_not_allowed`, users without the
claim with `groups_missing`); and a role per group for the connection's organization. The mapping works like the
instance-wide one: applied on every login, the highest matching role wins, the last owner is never demoted and every
change is audited. A user in none of the mapped groups joins with the default role and keeps their role afterwards.
Connections never remove members and never grant superadmin.

**Verified domains.** Add `example.com` under _Verified domains_, create the DNS TXT record the page
shows (`_marmot-verification.example.com` → `marmot-verification=<token>`) and press **Verify**. A verified
domain belongs to one organization only. People who enter an email on that domain on the **Sign in with
your organization's SSO** page (`/login/sso`) are sent to the organization's connections; the page also
accepts the organization slug, and `/login/sso?org=<slug>` is a shareable link that goes straight to the
organization's provider.

**Enforcement.** Once a domain is verified and a connection enabled, owners can switch on **Require
single sign-on**: password logins (`POST /api/users/login` and the Marmot login page) are refused for
every member whose email is on one of the organization's verified domains, with a message that points
at the SSO page. Owners of the organization keep a **break-glass** password login so a broken identity
provider never locks everyone out; each such login is written to the audit log as `auth.break_glass`.
Password resets follow the same rule: reset mails are only sent to people who could use the new
password (owners, superadmins and users outside the verified domains; everybody gets the same answer), and a
reset link of anyone else is refused with 403. [Email sign-in links](Organizations-and-Members.md#sign-in-links-passwordless)
follow the password rule too: nobody else on the verified domains receives one, a link sent earlier is refused with 403,
and an owner's sign-in through a link is audited as `auth.break_glass`; addresses on those domains never get an account
through a link. Logins through a connection are unaffected, and turning enforcement off restores password login at once.

Connections, domains and enforcement are also available over the API (`/api/orgs/:orgId/sso/connections`,
`/api/orgs/:orgId/sso/domains`, `POST /api/orgs/:orgId/sso/domains/:id/verify`,
`POST /api/orgs/:orgId/sso/metadata` to parse IdP metadata, `PATCH /api/orgs/:orgId/sso/enforcement`, and
the public `POST /api/auth/sso/lookup`).

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
- `/login?error=group_not_allowed` — the user is in none of the allowed groups (`OIDC_ALLOWED_GROUPS` or the
  connection's allow-list). The `auth.sso_group_denied` audit event lists the groups the provider sent.
- `/login?error=groups_missing` — an allow-list is set but the provider sent no group claim. Check `OIDC_GROUP_CLAIM`
  and that the client may see the groups (provider notes under _Groups_).
- `Password sign-in is turned off on this server` — `OIDC_DISABLE_LOCAL_LOGIN=true`. Superadmins use `/login?local=1`
  when `OIDC_BREAK_GLASS=true`.

## Under the hood

The protocol work lives in [`@thinkhuman/payload-plugin-auth`](https://github.com/ThinkHumanDotDev/payload-plugin-auth),
a reusable set of Payload plugins (OAuth 2.0 / OpenID Connect and SAML 2.0) maintained alongside Marmot.
`src/auth/sso` configures it: providers are resolved per request (today from the `OIDC_*` variables), the
routes under `/api/auth/{oidc,sso}` are Marmot's own so they share its rate limiting, and the hooks add
Marmot's rules (invitations, `DISABLE_SIGNUP`, the two-factor hand-off, the legacy column match). Linked
identities are rows of the `auth-accounts` collection.
