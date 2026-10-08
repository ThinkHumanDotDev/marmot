# Getting started

This page takes a fresh server to a working Marmot with one monitor, one notification channel and one
public status page. It assumes Docker; [Development](Development.md) covers running from source and
[Deployment](Deployment.md) the production details (reverse proxies, backups, upgrades).

## 1. Start the stack

Requirements: Docker Engine 24+ with the compose plugin, and, for HTTPS, a DNS name that points at the
host with ports 80 and 443 reachable from the internet.

```bash
mkdir marmot && cd marmot
base=https://raw.githubusercontent.com/ThinkHumanDotDev/marmot/main/docker
curl -fsSL $base/docker-compose.yml -o docker-compose.yml
curl -fsSL $base/Caddyfile -o Caddyfile
curl -fsSL $base/.env.example -o .env
```

Open `.env` and set at least:

| Variable                 | Value                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `PAYLOAD_SECRET`         | a long random string, e.g. the output of `openssl rand -hex 32`                             |
| `NEXT_PUBLIC_SERVER_URL` | the URL people will open, e.g. `https://status.example.com` (or `http://localhost` locally) |
| `DOMAIN`                 | `status.example.com` for automatic HTTPS; leave it commented out for plain HTTP on port 80  |
| `POSTGRES_PASSWORD`      | a password for the bundled Postgres                                                         |

Then:

```bash
docker compose up -d --wait
docker compose logs -f web      # watch the migrations run and the server start
```

The stack is five containers: `web` (UI, API, status pages), `worker` (runs the checks), `realtime`
(live updates), `postgres` and `redis`, with `caddy` in front. `web` applies database migrations on every
start, so there is nothing to run by hand. To use MongoDB instead of Postgres, download
`docker-compose.mongo.yml` from the same place and add `-f docker-compose.yml -f docker-compose.mongo.yml`
to every `docker compose` command.

## 2. Create the first account (setup wizard)

Open `https://status.example.com` (or `http://localhost`). While the instance has no users every page
redirects to `/setup`, which asks for:

- your **name**, **email** and a **password** (8 characters or more);
- the **name** and URL **slug** of your first organization (the slug becomes part of every URL, e.g.
  `/acme/monitors`).

Submitting creates the instance **superadmin** and the organization with you as its **owner** in one
transaction and signs you in. The wizard closes for good after that: later visitors land on `/login`, and
new people join through `/signup` (while sign-up is allowed) or an invitation
([Organizations and members](Organizations-and-Members.md)).

Superadmins can additionally open the Payload admin panel at `/admin`, which exposes **Instance settings**
(public URL, sign-up, retention, proxy trust) and raw access to every collection. Day-to-day work happens in
the Marmot UI, not the admin panel.

## 3. Add the first monitor

Go to **Monitors → New monitor**. The form asks for:

1. **Type**. Start with _HTTP(s)_: UP when the response status is accepted (`200-299` by default). Other
   types (keyword, JSON query, TCP port, ping, DNS, push, group, manual, and the extended set landing in the
   current release) are described in [Monitors](Monitors.md).
2. **Name** and **URL** (or hostname/port for the host-based types).
3. **Timing**: check every `interval` seconds (default 60, minimum 20), retry `maxRetries` times at
   `retryInterval` before going DOWN (default 0 retries), and `resendInterval` to re-alert while a monitor
   stays down (default 0 = alert once per transition).

Notification channels marked _default_ are attached automatically; pick other channels per monitor in the
form. Save. The worker schedules the monitor immediately and the first heartbeat shows up on the detail page
within one interval, together with the uptime cards (24h/30d), the response-time chart and the list of
status changes. The monitor list on `/acme/monitors` updates live over the WebSocket connection.

## 4. Get alerted

Go to **Notifications → New channel**, pick a provider (Slack, Discord, Telegram, SMTP email, ntfy, Gotify,
Pushover, webhook, PagerDuty, …; the full list is in [Notifications](Notifications.md)) and fill in the
form that the provider describes. **Send test** delivers a test message before you save. Tick **Default**
to attach the channel to every monitor created afterwards and **Apply to all existing monitors** to attach
it to the monitors you already have (for now this is how channels reach monitors; picking channels per
monitor in the monitor form lands in the current release).

Marmot alerts on status transitions (UP→DOWN, DOWN→UP, PENDING→DOWN) and, when `resendInterval` is set,
every N consecutive DOWN beats.

## 5. Publish a status page

Go to **Status pages → New page**, give it a title and a slug (`/status/<slug>`), then on the **Groups &
monitors** tab create a group ("Core services") and drag monitors into it. Switch **Published** on in the
header. The page is now public at `https://status.example.com/status/<slug>`, shows the last 50 beats and
the 24h/30d uptime of each monitor, and refreshes itself every few minutes. Post incidents from the
**Incidents** tab; the **Domains** tab serves the page on its own hostname (`status.yourproduct.com`), see
[Status pages](Status-Pages.md).

## 6. Invite your team

**Members → Invite** sends an email invitation with a role (`viewer`, `member`, `admin` or `owner`), or
copy the organization's **invite link** for a self-service join. With SMTP unset, invitation emails are
printed to the `web` container log (`docker compose logs web`) so you can copy the link from there.
Configure `SMTP_*` in `.env` to send real mail, and `OIDC_*` to let people sign in with your identity
provider ([Single sign-on](Single-Sign-On.md)).

## Where to next

- Harden and operate the install: [Deployment](Deployment.md) (reverse proxies, backups, upgrades).
- Tune it: [Configuration](Configuration.md) (every variable), the instance settings in `/admin`.
- Automate it: badges, the push endpoint, Prometheus metrics and API keys in
  [Integrations](Integrations.md).
