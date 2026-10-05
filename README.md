<p align="center">
  <h1 align="center">🐾 Marmot</h1>
  <p align="center">Self-hosted status monitor for teams.<br/>Uptime Kuma's monitoring and alerting, kan.bn's workspaces, built on Payload CMS.</p>
</p>

<p align="center">
  <a href="https://github.com/ThinkHumanDotDev/marmot/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ThinkHumanDotDev/marmot/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
  <a href="https://github.com/ThinkHumanDotDev/marmot/pkgs/container/marmot"><img alt="Container image" src="https://img.shields.io/badge/ghcr.io-marmot-blue?logo=docker"></a>
  <!-- release badge once v1.0 is tagged:
  <a href="https://github.com/ThinkHumanDotDev/marmot/releases"><img alt="Release" src="https://img.shields.io/github/v/release/ThinkHumanDotDev/marmot"></a>
  -->
</p>

> **Status:** pre-release, under active development. Expect breaking changes until `v1.0`.

## What is Marmot?

Marmot watches your HTTP endpoints, TCP ports, DNS records, databases and more, alerts you through dozens
of channels when something breaks, and publishes public status pages. Unlike single-user monitors it is
built for organizations: multiple teams, role-based access, invitations and single sign-on, in one
self-hosted install.

<!-- screenshots: dashboard (live monitor list), monitor detail, status page builder, public status page
<p align="center">
  <img src="docs/images/dashboard.png" alt="Marmot dashboard" width="800">
</p>
-->

## Features

- **Monitoring** – HTTP(s), keyword, JSON query, TCP port, ping, DNS, push, group and manual monitors on
  `main`; gRPC, WebSocket, MQTT, Kafka, RabbitMQ, SMTP, SNMP, NTP, SFTP, RADIUS, Tailscale, SQL/NoSQL
  databases, Steam and GameDig landing in the current release. Intervals from 20 s, retries, upside-down
  mode, certificate and domain expiry alerts.
- **Alerting** – 48 notification providers ported from Uptime Kuma: Slack, Discord, Telegram, Teams,
  Matrix, ntfy, Gotify, Pushover, SMTP, SendGrid, PagerDuty, Opsgenie, Twilio, webhooks and more. Default
  channels, message templates, test button, retried delivery.
- **Status pages** – any number of public pages per organization with monitor groups, incidents, custom
  CSS, custom domains, RSS and badges; maintenance banners landing.
- **Teams** – organizations with owner/admin/member/viewer roles, email invitations, invite links,
  ownership transfer, generic OIDC [single sign-on](docs/sso.md), first-run setup wizard.
- **Hosting-ready** – optional per-organization plan limits and Stripe [billing](docs/billing.md); off by default.
- **Live** – the dashboard updates in real time over WebSockets.
- **Integrations** – status badges, push monitors, Prometheus metrics and organization API keys
  ([docs/integrations.md](docs/integrations.md)).
- **Self-hosting first** – one Docker image, Postgres **or** MongoDB, Redis, Caddy for automatic HTTPS,
  no telemetry unless you turn it on.

## Quick start

```bash
mkdir marmot && cd marmot
base=https://raw.githubusercontent.com/ThinkHumanDotDev/marmot/main/docker
curl -fsSL $base/docker-compose.yml -o docker-compose.yml && curl -fsSL $base/Caddyfile -o Caddyfile
curl -fsSL $base/.env.example -o .env   # set PAYLOAD_SECRET, NEXT_PUBLIC_SERVER_URL and (for HTTPS) DOMAIN
docker compose up -d --wait
# open https://$DOMAIN (or http://localhost) and follow the setup wizard
```

Add `-f docker-compose.yml -f docker-compose.mongo.yml` to run on MongoDB. The walkthrough from empty
server to first status page is in [docs/getting-started.md](docs/getting-started.md).

## Documentation

The index is [docs/README.md](docs/README.md). Most-read pages:

| Run it                                     | Use it                                                         | Change it                                         |
| ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------- |
| [Getting started](docs/getting-started.md) | [Monitors](docs/monitors.md)                                   | [Architecture](docs/architecture.md)              |
| [Configuration](docs/configuration.md)     | [Notifications](docs/notifications.md)                         | [Development](docs/development.md)                |
| [Deployment](docs/deployment.md)           | [Status pages](docs/status-pages.md)                           | [Contributing](CONTRIBUTING.md)                   |
| [Single sign-on](docs/sso.md)              | [Organizations and members](docs/organizations-and-members.md) | [Comparison with Uptime Kuma](docs/comparison.md) |

## Development

```bash
pnpm install
cp .env.example .env            # defaults point at local Postgres + Redis
pnpm services:up                # docker compose dev services (or local binaries)
pnpm dev                        # web :3000, worker, realtime :3001
```

`pnpm check` runs lint, typecheck and the integration tests. Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/development.md](docs/development.md) before opening a pull request.

## Architecture

```
 browser ──HTTP──▶ web (Next.js + Payload: UI, admin, REST/GraphQL)
    │                     │ hooks ─▶ Redis (BullMQ job schedulers, pub/sub)
    └──WebSocket──▶ realtime (socket.io + redis adapter)   ◀── worker (BullMQ: checks, heartbeats, stats, notifications)
                                                                   │
                                            Postgres | MongoDB ◀───┘
```

One image, three roles (`MARMOT_ROLE=web|worker|realtime`, or `all`), scaled independently. Details in
[docs/architecture.md](docs/architecture.md).

## FAQ

**Is it a fork of Uptime Kuma?** No. Marmot is a new codebase on Payload CMS and Next.js. Where it saves
time it ports individual pieces of Uptime Kuma (MIT) — the heartbeat state machine, the uptime calculator,
monitor checks, notification providers — with attribution in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
[docs/comparison.md](docs/comparison.md) tracks feature parity.

**Can I import my Uptime Kuma data?** Yes: Settings → Import / Export reads an Uptime Kuma JSON backup
(with a dry run first); see [docs/import-export.md](docs/import-export.md).

**Postgres or MongoDB?** Either. Postgres is the default and ships in the compose file; MongoDB is a
one-line override. Every collection is written to work on both, and CI runs the whole suite on both.
SQLite is for local development only.

**Do I need Redis?** Yes. Redis holds the BullMQ job schedulers that drive the checks and the socket.io
pub/sub that powers the live dashboard. It needs no backup: the worker rebuilds its state from the
database on start.

**How many monitors can it handle?** The worker is a stateless queue consumer: run several
(`--scale worker=N`) and raise `WORKER_CONCURRENCY`. Heartbeats are rolled up into minutely/hourly/daily
buckets so the database stays small; raw beats are pruned after 24 hours.

**Can I run it behind my own reverse proxy?** Yes. Route `/socket.io/*` (with WebSocket upgrades) to the
realtime process and everything else to the web process; nginx and Traefik examples are in
[docs/deployment.md](docs/deployment.md).

**Does it phone home?** No. There is no telemetry unless an operator sets a PostHog key, and even then
visitors are asked for consent first. See **Privacy** below.

**Can one install serve several teams?** That is the point: organizations are isolated workspaces with
their own monitors, channels, status pages and members; a user can belong to several with different roles.

## Privacy

Marmot collects **nothing** by default: no analytics SDK, no cookie banner, no calls home. Operators who
want product analytics can opt in with `NEXT_PUBLIC_POSTHOG_KEY`; the UI then asks every visitor for
consent, identifies users only by a keyed hash and reduces URLs to route patterns.
[docs/telemetry.md](docs/telemetry.md) (landing in the current release) lists exactly what is collected and
how to turn it off. Security reports go through [SECURITY.md](SECURITY.md).

## License

Marmot is free software released under the [GNU Affero General Public License v3.0](LICENSE)
(AGPL-3.0-only). If you run a modified version as a network service you must offer its source to its users.

Marmot stands on two projects it gratefully acknowledges: [Uptime Kuma](https://github.com/louislam/uptime-kuma)
by Louis Lam (MIT), whose monitoring model, checks and notification providers it ports, and
[kan.bn](https://github.com/kanbn/kan) (AGPL-3.0), whose workspace, role and invitation model it follows.
Attributions and license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
