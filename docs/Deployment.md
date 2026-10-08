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

Whatever sits in front of Marmot has to do two things: send `/socket.io/*` (HTTP long-polling **and** the
WebSocket upgrade) to the realtime process and everything else to the web process. The bundled Caddyfile
does exactly that.

## Compose with Caddy (automatic HTTPS)

Requirements: Docker Engine 24+ with the compose plugin (`docker compose version` ≥ 2.24), a host with
ports 80 and 443 reachable from the internet and a DNS record pointing at it.

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

Open `https://$DOMAIN` (or `http://<host>`) and complete the setup wizard ([Getting started](Getting-Started.md)).
`web` runs the database migrations (`dist/server/migrate.mjs`, bundled at image build time) on every start,
so the schema is created on first boot and upgraded on later ones. The `worker` and `realtime` roles run
from the same pre-built bundles; the worker waits up to `WORKER_SCHEMA_WAIT_MS` (2 minutes) for the schema
to appear instead of crash-looping while `web` migrates.

Caddy obtains and renews the certificate for `DOMAIN` automatically and redirects HTTP to HTTPS. Status
pages on their own hostnames need on-demand TLS; see [Status pages](Status-Pages.md#custom-domains).

The rest of the configuration (SMTP, OIDC, S3 storage, retention, …) goes into the same `.env`; see
[Configuration](Configuration.md) for the full table. `docker/.env.example` lists the common ones.

## MongoDB instead of Postgres

Download `docker-compose.mongo.yml` from the same place and add it to every compose command:

```bash
curl -fsSL $base/docker-compose.mongo.yml -o docker-compose.mongo.yml
docker compose -f docker-compose.yml -f docker-compose.mongo.yml up -d --wait
```

The override sets `DATABASE_ADAPTER=mongodb`, points `DATABASE_URL` at a `mongo:7` service and disables the
Postgres container. MongoDB has no schema migrations; indexes are created when the processes boot. To use an
existing MongoDB (Atlas, a replica set) set `DATABASE_URL` in `.env` and keep the override for the adapter
setting.

## Behind an existing reverse proxy

Leave `DOMAIN` unset so Caddy serves HTTP on port 80, and remap the port to something free:

```yaml
# docker-compose.override.yml
services:
  caddy:
    ports: !override
      - '127.0.0.1:8080:80'
```

Point your proxy at `http://127.0.0.1:8080`, forward WebSocket upgrades, and set `NEXT_PUBLIC_SERVER_URL`
to the public `https://` URL. Marmot sends the `Strict-Transport-Security` header itself in production and
reads `X-Forwarded-Host` for custom status-page domains, so forward the original `Host`.

### nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name status.example.com;
    # ssl_certificate / ssl_certificate_key ...

    # socket.io: long-polling and the WebSocket upgrade
    location /socket.io/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;   # keep idle websockets open
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 20m;   # logo uploads
    }
}
```

### Traefik

With Traefik the simplest setup drops Caddy and publishes the two Marmot services directly: give `web` the
catch-all router and `realtime` a higher-priority router for `/socket.io`. Traefik passes WebSocket upgrades
through without extra configuration.

```yaml
# docker-compose.override.yml
services:
  caddy:
    profiles: ['disabled']
  web:
    labels:
      traefik.enable: 'true'
      traefik.http.routers.marmot.rule: Host(`status.example.com`)
      traefik.http.routers.marmot.entrypoints: websecure
      traefik.http.routers.marmot.tls.certresolver: letsencrypt
      traefik.http.services.marmot.loadbalancer.server.port: '3000'
  realtime:
    labels:
      traefik.enable: 'true'
      traefik.http.routers.marmot-rt.rule: Host(`status.example.com`) && PathPrefix(`/socket.io`)
      traefik.http.routers.marmot-rt.entrypoints: websecure
      traefik.http.routers.marmot-rt.tls.certresolver: letsencrypt
      traefik.http.routers.marmot-rt.priority: '100'
      traefik.http.services.marmot-rt.loadbalancer.server.port: '3001'
```

Attach both services to Traefik's network. The same split (everything to `web:3000`, `/socket.io/*` to
`realtime:3001`) applies to any other proxy or ingress controller, including Cloudflare Tunnel (enable
WebSockets on the tunnel) and Kubernetes ingresses (two path rules, WebSocket timeouts raised; the
[Helm chart](Kubernetes.md#ingress-and-realtime) renders them).

## Railway

The Railway template deploys the same stack as the compose file, with each role as its own service:

- `edge`: Caddy, the only public service.
- `web`, `worker` and `realtime`.
- Postgres.
- Redis, configured with `noeviction` and persistence.

Railway provides HTTPS on the `edge` domain. Secrets are generated at deploy time, so the only thing to do
after deploying is to open the domain and complete the setup wizard.

- **Custom domain**: add it to the `edge` service. Then set `NEXT_PUBLIC_SERVER_URL` on `web`, `worker` and
  `realtime` to `https://your.domain`.
- **Configuration**: SMTP, OIDC, S3 and the rest go into the variables of `web`, `worker` and `realtime`
  (see [Configuration](Configuration.md)).
- **Scaling**: give `worker` more replicas. `realtime` replicas need sticky sessions (see
  [Scaling](#scaling)), so keep one.
- **Uploads**: logos and other uploads live on the `web` volume. Set `S3_BUCKET` before running more than
  one `web` replica.
- **Upgrading**: each release updates the image tags under `deploy/railway/` in this repository.
  Redeploying the services from the template's repository picks the new release up. Migrations run when
  `web` starts.

How the template is built, and how to rebuild it, is described in
[`deploy/railway/README.md`](../deploy/railway/README.md).

## Kubernetes (Helm)

The Helm chart in `charts/marmot` (published as `oci://ghcr.io/thinkhumandotdev/charts/marmot` with every
release) runs `web`, `worker` and `realtime` as separate Deployments with their own replicas, resources and
autoscalers, or one `MARMOT_ROLE=all` pod. A Job runs the migrations, as a `pre-upgrade` hook on upgrades,
so new pods only start against a migrated schema. Postgres or MongoDB and Redis are external, or Postgres
and Redis are bundled for evaluation; secrets come from an existing Secret or from the values.

```bash
helm install marmot oci://ghcr.io/thinkhumandotdev/charts/marmot -n marmot --create-namespace \
  --set serverUrl=https://status.example.com --set postgresql.enabled=true --set redis.enabled=true \
  --set ingress.enabled=true --set ingress.host=status.example.com
```

The full guide (values, ingress and `/socket.io`, TLS for custom status-page domains, scaling, probe agents)
is [Kubernetes](Kubernetes.md).

## Running the image without compose

Any orchestrator works as long as each role gets the same environment:

```bash
docker run -d --name marmot-web -p 3000:3000 \
  -e MARMOT_ROLE=web -e PAYLOAD_SECRET=... -e NEXT_PUBLIC_SERVER_URL=https://status.example.com \
  -e DATABASE_URL=postgres://marmot:secret@db:5432/marmot -e REDIS_URL=redis://redis:6379 \
  -v marmot_uploads:/app/uploads ghcr.io/thinkhumandotdev/marmot:latest
docker run -d --name marmot-worker   -e MARMOT_ROLE=worker   ... ghcr.io/thinkhumandotdev/marmot:latest
docker run -d --name marmot-realtime -e MARMOT_ROLE=realtime -p 3001:3001 ... ghcr.io/thinkhumandotdev/marmot:latest
```

- The image runs as the unprivileged user `marmot` (uid 1001) under `tini`; `SIGTERM` shuts every role
  down cleanly (the worker finishes in-flight checks, up to 30 s).
- Health: `web` answers `GET /api/health` (checks the database; its `checker` field reports the workers'
  [self connectivity check](Configuration.md#self-connectivity-check)), `realtime` answers `GET /healthz`. The
  image's `HEALTHCHECK` calls `/app/entrypoint.sh healthcheck`, which picks the right probe for the role.
- `docker run --rm ... ghcr.io/thinkhumandotdev/marmot migrate` runs migrations and exits. Set
  `SKIP_MIGRATIONS=true` on `web` when you run them yourself (CI/CD step, init container).
- Uploads are stored in `/app/uploads` (volume) unless `S3_BUCKET` is configured.

### Single container (`MARMOT_ROLE=all`)

```bash
docker run -d --name marmot -p 3000:3000 -p 3001:3001 \
  -e MARMOT_ROLE=all -e PAYLOAD_SECRET=... -e NEXT_PUBLIC_SERVER_URL=http://localhost:3000 \
  -e DATABASE_URL=postgres://... -e REDIS_URL=redis://... \
  -v marmot_uploads:/app/uploads ghcr.io/thinkhumandotdev/marmot:latest
```

The entrypoint runs the migrations, then supervises the three processes and exits (non-zero) when any of
them dies so the orchestrator restarts the container. Fine for evaluation and small installs; split the
roles to scale or to restart them independently. In this mode the browser still expects `/socket.io` on
the web origin, so put a proxy in front that routes it to port 3001 (or set `NEXT_PUBLIC_REALTIME_URL` in
your own build).

## Scaling

- **Workers** are stateless BullMQ consumers: `docker compose up -d --scale worker=3`. Each runs
  `WORKER_CONCURRENCY` (default 10) checks in parallel; BullMQ guarantees a monitor is checked by one worker
  at a time. A worker is a single Node.js process, so it can use at most one CPU core: one worker handles
  about **25 checks/s**, and raising `WORKER_CONCURRENCY` beyond that no longer helps (see
  [Sizing](#sizing)). Keep `WORKER_CONCURRENCY` around 10–20 and add worker replicas instead; raise it only
  when most checks wait on slow targets or long timeouts rather than on the CPU.
- **Realtime** replicas share state through the Redis adapter, so several can run; the proxy in front then
  needs sticky sessions (or WebSocket-only transport) because socket.io's polling handshake must land on the
  same replica.
- **Web** is a regular Next.js server and scales horizontally behind the proxy. Only one replica should run
  migrations: set `SKIP_MIGRATIONS=true` on the others or run `migrate` as a separate step.
- **Postgres** does about a third of the CPU work of the checks (every beat writes a heartbeat and updates
  the stats buckets). Give it room when you add workers, and run it on its own host once the workers need
  more than a couple of cores.
- **Redis** must run with `maxmemory-policy noeviction` and persistence (`--save`) so job schedulers survive
  a restart; the compose file configures both.

With the [self connectivity check](Configuration.md#self-connectivity-check) enabled, every worker replica
probes the targets on its own (a few requests every `CONNECTIVITY_CHECK_INTERVAL` seconds), while the
"checker offline" notice is still sent only once per outage.

### Sizing

Work out the check rate first: **checks/s = Σ (1 / interval)** over the active monitors. 600 monitors at
60 s are 10 checks/s; add 400 at 20 s and it is 30 checks/s. Then size from the figures below.

> **Measured on one machine, as a rough guide.** `main` as of 2026-10-06 (after v0.1.1), production build
> with separate web / worker / realtime processes, Postgres 16, Redis 7, 4 vCPU, HTTP monitors against an
> endpoint that answers in 150 ms. Slower targets, HTTPS, keywords or other monitor types change the
> numbers; measure your own load before relying on them.

| Monitors                    | Wanted checks/s | Workers × concurrency | Achieved checks/s | Worker CPU |
| --------------------------- | --------------: | --------------------- | ----------------: | ---------: |
| 600 at 60 s / 30 s          |              18 | 1 × 10                |              18.3 | 0.64 cores |
| 1,000 at 60 s / 30 s / 20 s |              38 | 1 × 10                |          **23.8** | 0.81 cores |
| same                        |              38 | 1 × 40                |          **30.1** | 1.07 cores |
| same                        |              38 | **2 × 20**            |              40.3 | 1.56 cores |

One worker falls behind at about 25–30 checks/s whatever its concurrency; a second replica catches up.
Rules of thumb from the same run:

- **Workers:** one replica per ~25 checks/s, with `WORKER_CONCURRENCY` at 10–20.
- **CPU:** about 0.04 worker cores per check/s (HTTPS adds about 10–15% for the TLS handshake), plus about
  0.02 Postgres cores per check/s.
- **Memory:** a worker uses about 250 MB at concurrency 10 and about 500 MB at 20–40; web about 310 MB,
  realtime about 170 MB.
- **Disk:** a row is about 240 B per heartbeat, 260 B per minutely, 350 B per hourly and 480 B per daily
  bucket. With the default retention (non-important beats and minutely buckets 24 h, hourly buckets 30 days,
  daily buckets and important beats `KEEP_DATA_PERIOD_DAYS` = 365 days) that is about 1.0 / 1.4 / 1.9 MB per
  monitor at 60 / 30 / 20 s intervals.

For example, 1,000 monitors at 60 s (about 17 checks/s) fit one worker at the default concurrency, use about
0.7 worker cores and 0.35 Postgres cores, and about 1 GB of database. Retention runs hourly; see
[Configuration](Configuration.md) for `KEEP_DATA_PERIOD_DAYS` and the instance setting that overrides it.

## Backups and restore

Everything lives in three places: the database, the `uploads` volume (unless S3) and your `.env`.

```bash
# Postgres
docker compose exec -T postgres pg_dump -U marmot -Fc marmot > marmot-$(date +%F).dump
# MongoDB
docker compose exec -T mongo mongodump --archive --db marmot > marmot-$(date +%F).archive
# Uploads (skip when using S3)
docker run --rm -v marmot_uploads:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/marmot-uploads-$(date +%F).tgz -C /data .
```

Restore into a stopped stack (keep `postgres`/`mongo` and `redis` running):

```bash
docker compose stop web worker realtime
# Postgres
docker compose exec -T postgres pg_restore -U marmot -d marmot --clean --if-exists < marmot-2026-10-05.dump
# MongoDB
docker compose exec -T mongo mongorestore --archive --db marmot --drop < marmot-2026-10-05.archive
# Uploads
docker run --rm -v marmot_uploads:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/marmot-uploads-2026-10-05.tgz -C /data'
docker compose up -d --wait
```

Redis only holds queue state and live sockets; it does not need a backup. The worker re-creates every job
scheduler from the monitors in the database when it starts (`resyncAll`). Restoring a backup taken with an
older version is fine: `web` applies the missing migrations on start.

## Upgrading

```bash
docker compose pull
docker compose up -d --wait
```

`web` applies pending migrations before it starts serving; `worker` and `realtime` restart with the new
image. Pin `MARMOT_VERSION` in `.env` (e.g. `MARMOT_VERSION=1.2`) to control when upgrades happen, and
take a database backup before a major version. Release notes list breaking changes.

Images are published for `linux/amd64` and `linux/arm64` on every release tag: `X.Y.Z`, `X.Y` and
`latest` (final releases only; prereleases such as `X.Y.Z-rc.1` get their full version only). The
compose file of a release defaults `MARMOT_VERSION` to that release, so `docker compose pull` alone does
not jump to a newer version until you update `docker-compose.yml` or set `MARMOT_VERSION`. Changes per
version are in [`CHANGELOG.md`](../CHANGELOG.md); maintainers follow the
[release checklist](Release-Checklist.md).

### Notification channels that use the server SMTP settings

Since `NOTIFICATIONS_SERVER_SMTP` (default `superadmin`), only instance superadmins can set up email
channels that send through the instance's `SMTP_*` settings. Channels that already did so keep sending,
whoever created them. Marmot does not record a channel's creator, so review all of them once after
upgrading: as a superadmin, list them in the REST API

```text
GET /api/notifications?where[type][equals]=smtp&where[config.useServerSmtp][equals]=true&depth=0&limit=0
```

or in the admin panel at `/admin/collections/notifications?where[type][equals]=smtp&where[config.useServerSmtp][equals]=true`
(the same filter in the URL). Each result names its `organization`; edit or delete the channels you did not
expect, or set `NOTIFICATIONS_SERVER_SMTP=off` to stop all of them.

## Hardening

Before exposing an instance to the internet, go through the checklist in [Security](Security.md): TLS,
the `trustProxy` instance setting (rate limiting and the audit log need the real client address), a strong
`PAYLOAD_SECRET`, closed signup and private database/Redis ports.

## Troubleshooting

- `docker compose ps` shows `web` unhealthy: `docker compose logs web`. Most often `DATABASE_URL` points
  at the wrong host (inside compose it must be `postgres`/`mongo`, not `localhost`) or
  `PAYLOAD_SECRET` is missing.
- Caddy cannot obtain a certificate: check that `DOMAIN` resolves to this host and that ports 80 and 443
  are open; `docker compose logs caddy` shows the ACME errors.
- Live updates are missing: the WebSocket upgrade for `/socket.io/` is not reaching the `realtime`
  service. `curl 'http://<host>/socket.io/?EIO=4&transport=polling'` should return a `sid`.
- Login works but every request after a redirect fails with 403: `NEXT_PUBLIC_SERVER_URL` does not match
  the URL in the browser (scheme, host or port), so the CSRF/CORS allow-list rejects the cookie.
- The worker logs `database not ready yet; retrying`: migrations in `web` are still running. It gives up
  after `WORKER_SCHEMA_WAIT_MS`; raise it on very slow disks.
- Invitation mails never arrive: without `SMTP_HOST` they are printed to the `web` log. Check
  `docker compose logs web | grep invite`.
