<p align="center">
  <h1 align="center">🐾 Marmot</h1>
  <p align="center">Self-hosted status monitor for teams.<br/>Uptime Kuma's monitoring and alerting, kan.bn's workspaces, built on Payload CMS.</p>
</p>

<p align="center">
  <a href="https://github.com/ThinkHumanDotDev/marmot/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ThinkHumanDotDev/marmot/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
</p>

> **Status:** pre-release, under active development. Expect breaking changes until `v1.0`.

## What is Marmot?

Marmot watches your HTTP endpoints, TCP ports, DNS records, databases and more, alerts you through
dozens of channels when something breaks, and publishes beautiful public status pages. Unlike single-user
monitors it is built for organizations: multiple teams, role-based access, invitations and SSO.

- **Monitoring** – HTTP(s), keyword, JSON query, TCP, ping, DNS, push, groups and many more; configurable
  intervals, retries, upside-down mode, certificate expiry alerts.
- **Alerting** – extensible notification providers (SMTP, Discord, Slack, Telegram, Teams, ntfy, Gotify,
  Pushover, PagerDuty, Opsgenie, Webhook, …).
- **Status pages** – public pages with groups, incidents, maintenance banners, custom CSS and badges.
- **Teams** – organizations, roles, invitations, generic OIDC [single sign-on](docs/sso.md).
- **Live** – the dashboard updates in real time over WebSockets.
- **Integrations** – status badges, push monitors, Prometheus metrics and organization API keys
  ([docs/integrations.md](docs/integrations.md)).
- **Self-hosting first** – one Docker image, Postgres **or** MongoDB, Redis, Caddy for automatic HTTPS.

## Quick start (Docker)

```bash
mkdir marmot && cd marmot
base=https://raw.githubusercontent.com/ThinkHumanDotDev/marmot/main/docker
curl -fsSL $base/docker-compose.yml -o docker-compose.yml
curl -fsSL $base/Caddyfile -o Caddyfile
curl -fsSL $base/.env.example -o .env
# edit .env: set PAYLOAD_SECRET, NEXT_PUBLIC_SERVER_URL and (for HTTPS) DOMAIN
docker compose up -d --wait
```

Open `https://$DOMAIN` (or `http://localhost`) and follow the setup wizard. To run on MongoDB instead of
Postgres add `-f docker-compose.mongo.yml`. See [docs/deployment.md](docs/deployment.md) for reverse
proxies, backups and upgrades, and [docs/configuration.md](docs/configuration.md) for every environment
variable.

## Development

```bash
pnpm install
cp .env.example .env            # defaults point at local Postgres + Redis
pnpm services:up                # docker compose dev services (or local binaries)
pnpm dev                        # web :3000, worker, realtime :3001
```

Useful commands: `pnpm check` (lint + typecheck + integration tests), `pnpm test:e2e`,
`pnpm generate:types`, `pnpm migrate:create`. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## Architecture

```
 browser ──HTTP──▶ web (Next.js + Payload: UI, admin, REST/GraphQL)
    │                     │ hooks ─▶ Redis (BullMQ job schedulers, pub/sub)
    └──WebSocket──▶ realtime (socket.io + redis adapter)   ◀── worker (BullMQ: checks, heartbeats, stats, notifications)
                                                                   │
                                            Postgres | MongoDB ◀───┘
```

One image, three roles (`MARMOT_ROLE=web|worker|realtime`), scaled independently. Details in
[docs/architecture.md](docs/architecture.md).

## License

Marmot is released under the [GNU AGPL v3](LICENSE). It is heavily inspired by, and in places ports code
from, [Uptime Kuma](https://github.com/louislam/uptime-kuma) (MIT) and [kan.bn](https://github.com/kanbn/kan)
(AGPL-3.0). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
