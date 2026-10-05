# Deployment

Marmot ships as one Docker image (`ghcr.io/thinkhumandotdev/marmot`) that runs three roles selected
with `MARMOT_ROLE`: `web` (Next.js + Payload), `worker` (checks, heartbeats, notifications) and
`realtime` (socket.io). `MARMOT_ROLE=all` runs the three in a single container. Alongside it you need
Postgres (or MongoDB) and Redis; the compose stack adds Caddy for automatic HTTPS.

```
 internet ──443/80──▶ caddy ──/socket.io/*──▶ realtime :3001 ──┐
                        │                                       ├──▶ redis
                        └──────────/*──────▶ web :3000 ─────────┤
                                                worker ─────────┘──▶ postgres | mongodb
```

## Compose quick start

Requirements: Docker Engine 24+ with the compose plugin (`docker compose version` ≥ 2.24), a host with
ports 80 and 443 reachable from the internet and a DNS record pointing at it (for HTTPS).

```bash
mkdir marmot && cd marmot
base=https://raw.githubusercontent.com/ThinkHumanDotDev/marmot/main/docker
curl -fsSL $base/docker-compose.yml -o docker-compose.yml
curl -fsSL $base/Caddyfile -o Caddyfile
curl -fsSL $base/.env.example -o .env
```

Edit `.env`:

| Variable                 | Set it to                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `PAYLOAD_SECRET`         | `openssl rand -hex 32`                                                               |
| `NEXT_PUBLIC_SERVER_URL` | the URL users will open, e.g. `https://status.example.com`                           |
| `DOMAIN`                 | `status.example.com` for automatic HTTPS; leave unset to serve plain HTTP on port 80 |
| `ACME_EMAIL`             | optional; the certificate authority uses it for expiry notices                       |
| `POSTGRES_PASSWORD`      | a password for the bundled Postgres (the `DATABASE_URL` default picks it up)         |

Then:

```bash
docker compose up -d --wait
docker compose logs -f web      # watch migrations run and the server start
```

Open `https://$DOMAIN` (or `http://<host>`) and create the first user. `web` runs `payload migrate` on
every start, so the schema is created on first boot and upgraded on later ones.

**MongoDB instead of Postgres**: download `docker-compose.mongo.yml` from the same place and add it to
every compose command:

```bash
docker compose -f docker-compose.yml -f docker-compose.mongo.yml up -d --wait
```

**Scaling**: `docker compose up -d --scale worker=3`. Several `realtime` replicas also work (they share
state through the Redis adapter) but need a load balancer with sticky sessions in front of Caddy.

The rest of the configuration (SMTP, OIDC, S3 storage, retention, …) goes into the same `.env`; see
[configuration.md](configuration.md) for the full table. `docker/.env.example` lists the common ones.

## Behind an existing reverse proxy

Leave `DOMAIN` unset so Caddy serves HTTP on port 80, and remap the port to something free:

```yaml
# docker-compose.override.yml
services:
  caddy:
    ports: !override
      - '127.0.0.1:8080:80'
```

Point your proxy (nginx, Traefik, Cloudflare Tunnel, …) at `http://127.0.0.1:8080` and make sure it
forwards WebSocket upgrades for `/socket.io/` (nginx: `proxy_http_version 1.1; proxy_set_header Upgrade
$http_upgrade; proxy_set_header Connection "upgrade";`). Set `NEXT_PUBLIC_SERVER_URL` to the public
`https://` URL; the `Strict-Transport-Security` header is sent by Marmot itself in production.

You can also drop Caddy entirely (`caddy: { profiles: ['disabled'] }` in an override, publish
`web:3000` and `realtime:3001`) and route `/socket.io/*` to realtime and everything else to web in your
own proxy.

## Running the image without compose

Any orchestrator works as long as each role gets the same environment:

```bash
docker run -d --name marmot-web -p 3000:3000 \
  -e MARMOT_ROLE=web -e PAYLOAD_SECRET=... -e NEXT_PUBLIC_SERVER_URL=https://status.example.com \
  -e DATABASE_URL=postgres://marmot:secret@db:5432/marmot -e REDIS_URL=redis://redis:6379 \
  -v marmot_uploads:/app/uploads ghcr.io/thinkhumandotdev/marmot:latest
docker run -d --name marmot-worker   -e MARMOT_ROLE=worker   ... ghcr.io/thinkhumandotdev/marmot:latest
docker run -d --name marmot-realtime -e MARMOT_ROLE=realtime ... ghcr.io/thinkhumandotdev/marmot:latest
```

- The image runs as the unprivileged user `marmot` (uid 1001) under `tini`; `SIGTERM` shuts every role
  down cleanly.
- Health: `web` answers `GET /api/health` (checks the database), `realtime` answers `GET /healthz`. The
  image's `HEALTHCHECK` calls `/app/entrypoint.sh healthcheck`, which picks the right probe for the role.
- `docker run --rm ... ghcr.io/thinkhumandotdev/marmot migrate` runs migrations and exits. Set
  `SKIP_MIGRATIONS=true` on `web` when you run them yourself (CI/CD step, init container).
- Uploads are stored in `/app/uploads` (volume) unless `S3_BUCKET` is configured.
- `MARMOT_ROLE=all` is fine for small installs and evaluation; split the roles to scale.

## Backups

Everything lives in three places: the database, the `uploads` volume and your `.env`.

```bash
# Postgres
docker compose exec -T postgres pg_dump -U marmot -Fc marmot > marmot-$(date +%F).dump
# MongoDB
docker compose exec -T mongo mongodump --archive --db marmot > marmot-$(date +%F).archive
# Uploads (skip when using S3)
docker run --rm -v marmot_uploads:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/marmot-uploads-$(date +%F).tgz -C /data .
```

Restore with `pg_restore -U marmot -d marmot --clean --if-exists` / `mongorestore --archive --db marmot`
and untar into the volume. Redis only holds queue state and live sockets; it does not need a backup.
Monitors are re-scheduled by the worker on start.

## Upgrading

```bash
docker compose pull
docker compose up -d --wait
```

`web` applies pending migrations before it starts serving; `worker` and `realtime` restart with the new
image. Pin `MARMOT_VERSION` in `.env` (e.g. `MARMOT_VERSION=1.2`) to control when upgrades happen, and
take a database backup before a major version. Release notes list breaking changes.

## Troubleshooting

- `docker compose ps` shows `web` unhealthy: `docker compose logs web`. Most often `DATABASE_URL` points
  at the wrong host (inside compose it must be `postgres`/`mongo`, not `localhost`) or
  `PAYLOAD_SECRET` is missing.
- Caddy cannot obtain a certificate: check that `DOMAIN` resolves to this host and that ports 80 and 443
  are open; `docker compose logs caddy` shows the ACME errors.
- Live updates are missing: the WebSocket upgrade for `/socket.io/` is not reaching the `realtime`
  service. `curl 'http://<host>/socket.io/?EIO=4&transport=polling'` should return a `sid`.
