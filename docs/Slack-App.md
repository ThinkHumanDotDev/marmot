# Slack app

_(landing in the current release)_

Besides the plain [Slack notification channel](Notifications.md#providers) (an incoming webhook), Marmot
ships an optional, self-hosted **Slack app**. Each organization installs it into its own Slack workspace,
and then:

- `/marmot subscribe <status page URL>` subscribes a channel to a status page: its incident and maintenance
  updates are posted there (Block Kit messages, the same announcements email and webhook
  [subscribers](Status-Pages.md#subscribers) get);
- `/marmot status` shows the organization's monitors or a status page;
- `/marmot incident create | update | resolve` opens a form to post a status page incident update without
  leaving Slack;
- alerts sent through a **Slack (app)** notification channel carry **Acknowledge** (the monitor's
  [incident](Monitors.md#incidents)) and **Check now** buttons.

The app is off unless the instance operator sets its three environment variables; without them every
Slack route answers `404`, Settings → Integrations shows no Slack card and the **Slack (app)** channel type
is not offered.

## Creating the Slack app

Every Marmot instance uses its own Slack app (Slack apps are tied to the URLs they call). An operator
creates it once:

1. Open <https://api.slack.com/apps>, choose **Create New App → From an app manifest**, pick the workspace
   that will own the app and paste the manifest below, with `https://status.example.com` replaced by your
   `NEXT_PUBLIC_SERVER_URL` (the URLs must be reachable from the internet over HTTPS).
2. Under **Basic Information → App Credentials**, copy the **Client ID**, **Client Secret** and
   **Signing Secret** into `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET`
   ([Configuration](Configuration.md#slack-app)) and restart the web process.
3. To let organizations install the app into workspaces other than the one that owns it, turn on
   **Manage Distribution → Public Distribution** (Slack does not list the app anywhere; it only allows the
   OAuth install from other workspaces).

```yaml
display_information:
  name: Marmot
  description: Status pages, incident updates and alerts from Marmot
  background_color: '#1f2937'
features:
  bot_user:
    display_name: Marmot
    always_online: true
  slash_commands:
    - command: /marmot
      url: https://status.example.com/api/slack/commands
      description: Monitor status, status page subscriptions and incident updates
      usage_hint: help | status [name] | subscribe URL | incident create
      should_escape: false
oauth_config:
  redirect_urls:
    - https://status.example.com/api/slack/oauth/callback
  scopes:
    bot:
      - commands
      - chat:write
      - chat:write.public
settings:
  event_subscriptions:
    request_url: https://status.example.com/api/slack/events
    bot_events:
      - app_uninstalled
      - tokens_revoked
  interactivity:
    is_enabled: true
    request_url: https://status.example.com/api/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

| Endpoint                                  | Called by | Purpose                                                                        |
| ----------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| `POST /api/slack/commands`                | Slack     | the `/marmot` slash command                                                    |
| `POST /api/slack/interactions`            | Slack     | button clicks and the incident form                                            |
| `POST /api/slack/events`                  | Slack     | URL verification; `app_uninstalled` / `tokens_revoked` remove the installation |
| `GET /api/slack/oauth/callback`           | browser   | Slack's redirect after **Add to Slack**                                        |
| `GET /api/orgs/:orgId/slack/install`      | browser   | starts **Add to Slack** (`integration:manage`)                                 |
| `GET/DELETE /api/orgs/:orgId/slack`       | app, API  | the installation and linked users (`integration:read`) / remove it (`:manage`) |
| `DELETE /api/orgs/:orgId/slack/links/:id` | app, API  | unlink a Slack user (`integration:manage`)                                     |
| `POST /api/slack/link`                    | browser   | confirms `/marmot link` for the signed-in member                               |

## Installing it in an organization

An admin (`integration:manage`) opens **Settings → Integrations** and clicks **Add to Slack**. Slack asks
which workspace to install into; after **Allow**, Marmot stores the workspace's bot token and links the
admin's Slack account to their Marmot account. A workspace belongs to one organization at a time
(installing it from a second organization is refused), and an organization has one workspace (installing
another one replaces it). **Remove from Slack** revokes the token, unlinks every Slack user and ends the
channel subscriptions made with `/marmot subscribe`; uninstalling the app in Slack does the same.

## Linking Slack users

Anyone in the workspace may use the read-only commands (`help`, `subscriptions`, `status` of a status
page). Everything that changes something (subscribing a channel, posting an incident update, acknowledging,
**Check now**) and the organization's own monitor list need a **linked** Slack user, and then runs with the
linked member's permissions in the installing organization:

1. Run `/marmot link`. Marmot answers (only to you) with a link that is valid for 15 minutes.
2. Open it, sign in to Marmot if needed, and confirm. Only members of the installing organization can link.

`/marmot unlink` removes your link; admins see and remove links on the Slack card in Settings →
Integrations. A member who leaves the organization stops being able to act through Slack at once.

## Commands

| Command                                    | Needs                                          | What it does                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/marmot help`                             | —                                              | lists the commands                                                                                                                                                                                  |
| `/marmot status`                           | linked, `monitor:read`                         | counts of up/down monitors and the monitors that are down                                                                                                                                           |
| `/marmot status <name>`                    | — for a status page; linked for monitors       | a status page (slug or URL: overall state, components, active incidents) or the monitors whose name contains `<name>`                                                                               |
| `/marmot subscribe <URL>`                  | linked; `subscriber:manage` for your own pages | subscribes the channel to a status page of this instance (`https://<server>/status/<slug>`, a custom domain, or the slug). Pages of other organizations must be public and offer the Slack channel. |
| `/marmot unsubscribe [URL]`                | linked                                         | ends the channel's subscription to that page (all of them without a URL)                                                                                                                            |
| `/marmot subscriptions`                    | —                                              | the status pages the channel follows                                                                                                                                                                |
| `/marmot incident create\|update\|resolve` | linked, `status-page:update`                   | opens a form: status page, title, status and message for a new incident; or one of the active incidents, the new status and the message for an update                                               |
| `/marmot link`, `/marmot unlink`           | —                                              | see above                                                                                                                                                                                           |

Channel subscriptions are ordinary [status page subscribers](Status-Pages.md#subscribers) of channel
`slack` whose target is `slack://<workspace>/<channel>`; they follow the page's delivery mode (review
before sending, or automatic), appear in the page's subscriber list and can be removed there. The
messages carry the usual manage and unsubscribe links. The bot posts to public channels on its own; for a
private channel, invite it first (`/invite @Marmot`), otherwise `/marmot subscribe` says so and subscribes
nothing.

## Alert buttons

Create a notification channel of type **Slack (app)** (Notifications → New channel) with the channel name
(`#alerts`) or ID, and attach it to monitors like any other channel. Its messages are posted by the bot
and carry:

- **Acknowledge** on DOWN alerts while the monitor's incident is open: acknowledges it like the dashboard
  does (recorded as "from Slack", stops the escalation) and posts who acknowledged in the channel;
- **Check now** for monitor types that support it: runs the check on the worker and replies with the
  result (only to the person who clicked);
- **Open in Marmot**.

Acknowledging needs `monitor-incident:acknowledge`, **Check now** needs `monitor:update` (members), both
through a linked account; the buttons work only on incidents and monitors of the installing organization.

## Security

- Every request from Slack is verified with the signing secret: the `X-Slack-Signature` HMAC over the
  timestamp and the raw body, compared in constant time, with a timestamp no more than five minutes off.
  Unsigned, forged, tampered and replayed requests get `401` before anything is read.
- Bot tokens are encrypted at rest (AES-256-GCM with a key derived from `PAYLOAD_SECRET`, like two-factor
  and single sign-on secrets) and never readable through the API. Rotating `PAYLOAD_SECRET` makes them
  unreadable: reinstall the app afterwards.
- The OAuth state is signed, expires after ten minutes and is bound to the admin's browser (HttpOnly
  cookie) and session, so a forged callback cannot attach a workspace to another organization.
- Link links are signed, expire after 15 minutes, and linking is a POST from a signed-in member, so Slack's
  link previews cannot link anybody.
- Installing, removing and (un)linking are recorded in the [audit log](Security.md#audit-log)
  (`slack_installation.*`, `slack_user_link.*`); acknowledgements as `monitor_incident.acknowledged` with
  `via: slack`.
