# Organizations and members

Everything in Marmot lives inside an **organization**: monitors, notification channels, status pages,
maintenance windows and API keys. A user can belong to several organizations with a different role in each
and switches between them from the sidebar; each organization has its own URL prefix (`/acme/monitors`).
The model follows kan.bn's workspaces.

## Roles

Each membership has one of four roles. Permissions are `resource:action` strings mapped to the **minimum**
role that may perform them (`src/access/permissions.ts`); a role satisfies a permission when it ranks at or
above that minimum (`owner > admin > member > viewer`).

| What                                                     | viewer | member | admin | owner |
| -------------------------------------------------------- | :----: | :----: | :---: | :---: |
| See monitors, status pages, maintenance, members         |   ✓    |   ✓    |   ✓   |   ✓   |
| Create, edit, pause, delete monitors                     |        |   ✓    |   ✓   |   ✓   |
| Create, edit, publish, delete status pages and incidents |        |   ✓    |   ✓   |   ✓   |
| Schedule and edit maintenance windows                    |        |   ✓    |   ✓   |   ✓   |
| See notification channels (secrets masked)               |        |   ✓    |   ✓   |   ✓   |
| Create, edit, test, delete notification channels         |        |        |   ✓   |   ✓   |
| Invite members, change roles, remove members             |        |        |   ✓   |   ✓   |
| Edit organization name, slug, logo, settings             |        |        |   ✓   |   ✓   |
| Manage API keys                                          |        |        |   ✓   |   ✓   |
| Transfer ownership, delete the organization              |        |        |       |   ✓   |

Nobody can grant a role above their own (`canManageRole`), an admin cannot remove or demote an owner, and an
organization always keeps at least one owner: the last owner cannot be demoted, removed or leave.

The exact permission strings, for anyone writing code or reading the access functions:

| Permission                                                                                                                                                                                            | Minimum role |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `organization:read`, `member:read`, `monitor:read`, `monitor-incident:read`, `status-page:read`, `maintenance:read`                                                                                   | viewer       |
| `monitor:create\|update\|delete`, `monitor-incident:acknowledge\|resolve`, `status-page:create\|update\|delete`, `maintenance:create\|update\|delete`, `notification:read`, `subscriber:read\|manage` | member       |
| `organization:update`, `member:invite\|remove\|update-role`, `notification:create\|update\|delete`, `api-key:read\|create\|delete`, `sso:read`, `subscriber:send`                                     | admin        |
| `organization:delete`, `sso:manage`                                                                                                                                                                   | owner        |

### Superadmins

The account created by the setup wizard is the instance **superadmin**. Superadmins bypass every
organization check, can open the Payload admin panel at `/admin` (nobody else can) and manage instance
settings there. Promote another user by ticking `superadmin` on their user document in the admin panel.
Keep the number small; superadmin is an operator role, not a team role.

## Creating organizations

The setup wizard creates the first organization. Afterwards any signed-in user can create more from the
organization switcher (**New organization**, `/onboarding`) and becomes its owner. Slugs are lower-case,
unique and cannot be a reserved word (`admin`, `api`, `status`, …); `GET /api/orgs/slug-available?slug=`
is what the form uses to check.

**Settings → Organization** (admins and owners) edits the name, slug, logo, timezone and first day of the
week. The **danger zone** at the bottom lets an owner transfer ownership or delete the organization, which
removes its invitations and memberships (delete or move its monitors, channels and status pages first).

## Inviting people

Two mechanisms, both on the **Members** page (`/{org}/members`):

**Email invitations** (`member:invite`, i.e. admins and owners) carry an email address and a role. The
invitee receives a link to `/invite/<token>` that is valid for seven days; opening it while signed in joins
the organization with that role, otherwise it offers to sign in or create an account first (even when
public sign-up is disabled). Pending invitations are listed with **Resend** (also extends the expiry) and
**Revoke**. An existing member who is invited again keeps their current role.

**Invite link**: one shareable link per organization with a fixed role (`/invite/<code>`). Anyone with the
link can join, so use it for onboarding a team quickly and **reset** or **disable** it afterwards from the
Members page. Only admins and owners can see the link.

Without an SMTP server configured, invitation emails are printed to the web process log, where the link
can be copied.

With SSO configured and `DISABLE_SIGNUP` on, a user who signs in through the identity provider for the first
time while holding a pending invitation is provisioned and placed in the organization in one step
([Single sign-on](Single-Sign-On.md)).

## Managing members

The members table shows every member with their role, owners first. Admins and owners can change roles
(up to their own rank) and remove members (of equal or lower rank); any member can **leave** an
organization they are not the sole owner of.

**Transfer ownership** (owners only, in the organization danger zone) makes another member the owner and
demotes the previous owner to admin. Use it before leaving or deleting your account: an account that is the
sole owner of any organization cannot be deleted until the organization has another owner.

## Account settings

**Settings → Account** (`/{org}/settings/account`) edits your name and avatar, your theme and language
(`users.language`; the picker appears once Marmot ships more than one language), changes your password (the
current password is required), manages the single sign-on identities linked to your account (**Connected
accounts**: link GitHub, Google or the company IdP, unlink any but the last way in; see
[Single sign-on](Single-Sign-On.md#connected-accounts)) and deletes your account (type your email to confirm;
refused while you are the sole owner of an organization). Password reset by email is available from the
login page (`/forgot-password`) when SMTP is configured.

## API

| Method & path                                                                                                                         | Permission / rule                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/invitations` `{ organization, email, role }`                                                                               | `member:invite` (Payload REST; the hook mints the token and sends the mail)                                                |
| `PATCH /api/invitations/:id` `{ status: "revoked" }`                                                                                  | `member:invite`                                                                                                            |
| `PATCH /api/orgs/:orgId/members/:userId` `{ role }`                                                                                   | `member:update-role`; target and new role at or below your own                                                             |
| `DELETE /api/orgs/:orgId/members/:userId`                                                                                             | own id: leave; otherwise `member:remove`                                                                                   |
| `POST /api/orgs/:orgId/invitations/:invitationId/resend`                                                                              | `member:invite`                                                                                                            |
| `GET` / `POST` / `DELETE /api/orgs/:orgId/invite-link`                                                                                | `member:invite`: read, (re)generate, disable                                                                               |
| `POST /api/orgs/:orgId/transfer-ownership` `{ userId }`                                                                               | owner                                                                                                                      |
| `POST /api/invite/:code/accept`                                                                                                       | signed-in user; accepts an invitation or invite-link code                                                                  |
| `GET` / `PATCH /api/account`, `POST /api/account/password`                                                                            | the signed-in user                                                                                                         |
| `GET /api/account/accounts`, `DELETE /api/account/accounts/:id`                                                                       | the signed-in user; unlinking the last identity of a password-less account is refused                                      |
| `GET /api/orgs/:orgId/sso/connections`, `GET /api/orgs/:orgId/sso/domains`                                                            | `sso:read` (admins and owners)                                                                                             |
| `POST`/`PATCH`/`DELETE` under `/api/orgs/:orgId/sso/*`, `POST …/domains/:id/verify`, `POST …/sso/metadata`, `PATCH …/sso/enforcement` | `sso:manage` (owners); see [Single sign-on](Single-Sign-On.md#per-organization-connections-hosted-and-multi-team-installs) |
| `DELETE /api/account` `{ confirm: email }`                                                                                            | the signed-in user, unless sole owner somewhere                                                                            |
| `GET /api/orgs/slug-available?slug=`                                                                                                  | signed-in user                                                                                                             |

Memberships themselves live on `users.organizations` and are writable only by superadmins through the
Payload API; the routes above are the supported way to change them. Implementation notes are in
[Architecture](Architecture.md#organizations-and-rbac).
