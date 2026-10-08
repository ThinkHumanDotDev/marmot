# Kubernetes

The Helm chart in [`charts/marmot`](../charts/marmot) deploys the published image
(`ghcr.io/thinkhumandotdev/marmot`) with each role in its own Deployment, a migration Job, an Ingress
that routes `/socket.io` to the realtime process, and optionally a bundled Postgres and Redis and
[probe agents](Probe-Locations.md). Each release publishes it as an OCI artifact at
`oci://ghcr.io/thinkhumandotdev/charts/marmot`, with the same version as the image. The commands below
install the newest release; add `--version X.Y.Z` to pin one (the chart version selects the image).

```
            ┌── Ingress <release>-web       /            ──▶ Service web :3000 ──▶ Deployment web (N)
 internet ──┤                                                                     │ uploads PVC or S3
            └── Ingress <release>-realtime  /socket.io   ──▶ Service realtime :3001 ─▶ Deployment realtime
                                                                 Deployment worker (N) ──┐
   Job migrate (install: regular Job, upgrade: pre-upgrade hook) ───▶ postgres | mongodb ◀┤
                                                                     redis ◀──────────────┘
```

Requirements: Kubernetes 1.25 or later, Helm 3.8 or later (OCI support), an ingress controller that passes
WebSocket upgrades (ingress-nginx, Traefik, HAProxy and most cloud controllers do) and a default storage
class for the uploads volume and the bundled databases.

## Quick start (evaluation)

The bundled Postgres and Redis are single pods without backups. They are fine for trying Marmot out and
for small installs you are happy to back up yourself.

```bash
helm install marmot oci://ghcr.io/thinkhumandotdev/charts/marmot \
  --namespace marmot --create-namespace \
  --set serverUrl=https://status.example.com \
  --set postgresql.enabled=true --set redis.enabled=true \
  --set ingress.enabled=true --set ingress.className=nginx --set ingress.host=status.example.com
```

The install creates the schema with a Job and `web` turns ready once it has finished (`kubectl -n marmot
logs -f job/marmot-migrate-1`). Then open the URL and complete the setup wizard
([Getting started](Getting-Started.md)). Without an ingress, `kubectl port-forward svc/marmot-web 3000`
serves the UI, but live updates need `/socket.io` on the same origin (see [Ingress](#ingress-and-realtime)).

`helm test marmot -n marmot` checks `/api/health`, the realtime `/healthz` and a socket.io handshake from
inside the cluster.

## Production values

Use managed databases (or operators such as CloudNativePG) and keep the secrets out of the values file:

```bash
kubectl -n marmot create secret generic marmot-secrets \
  --from-literal=PAYLOAD_SECRET="$(openssl rand -hex 32)" \
  --from-literal=DATABASE_URL='postgres://marmot:...@db.internal:5432/marmot' \
  --from-literal=REDIS_URL='redis://:...@redis.internal:6379' \
  --from-literal=SMTP_PASSWORD='...'
```

```yaml
# values.yaml
serverUrl: https://status.example.com
secrets:
  existingSecret: marmot-secrets
config:
  DISABLE_SIGNUP: 'true'
  EMAIL_FROM: Marmot <marmot@example.com>
  SMTP_HOST: smtp.example.com
  SMTP_USER: marmot
  S3_BUCKET: marmot-uploads # several web replicas need S3 (or a ReadWriteMany volume)
  S3_REGION: eu-central-1
persistence:
  enabled: false # uploads go to S3
web:
  replicas: 2
  pdb: { enabled: true }
worker:
  replicas: 2
ingress:
  enabled: true
  className: nginx
  host: status.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
  tls:
    - secretName: marmot-tls
      hosts: [status.example.com]
  realtime:
    annotations:
      nginx.ingress.kubernetes.io/proxy-read-timeout: '3600'
      nginx.ingress.kubernetes.io/proxy-send-timeout: '3600'
```

```bash
helm upgrade --install marmot oci://ghcr.io/thinkhumandotdev/charts/marmot \
  -n marmot -f values.yaml
```

Every key of the existing Secret becomes an environment variable of the web, worker, realtime and
migration pods, so further secrets (`OIDC_CLIENT_SECRET`, `S3_SECRET_ACCESS_KEY`, `GITHUB_CLIENT_SECRET`,
`STRIPE_SECRET_KEY`, …) simply go into the same Secret. Without `existingSecret` the chart creates the
Secret from `secrets.payloadSecret`, `secrets.databaseUrl`, `secrets.redisUrl` and `secrets.extra`, and
generates a `PAYLOAD_SECRET` that is kept across upgrades.

## Values

The full list with comments is [`values.yaml`](../charts/marmot/values.yaml). The main ones:

| Key                                     | Default                                    | What it does                                                                                                  |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `serverUrl`                             | `http://localhost:3000`                    | `NEXT_PUBLIC_SERVER_URL`: the exact URL users open.                                                           |
| `mode`                                  | `split`                                    | `split`: web, worker and realtime Deployments. `all`: one `MARMOT_ROLE=all` pod. `probes`: only probe agents. |
| `image.tag` / `image.digest`            | chart `appVersion`                         | Image to run; the chart version and the image version are the same.                                           |
| `database.adapter`                      | `postgres`                                 | `postgres` or `mongodb` (external only).                                                                      |
| `config`                                | `LOG_LEVEL`, `DOCKER_SOCKET_ENABLED=false` | Non-secret variables from [Configuration](Configuration.md), as strings.                                      |
| `secrets.existingSecret`                | empty                                      | Secret with `PAYLOAD_SECRET`, `DATABASE_URL`, `REDIS_URL` and any other secret variables.                     |
| `secrets.databaseUrl` / `redisUrl`      | empty                                      | Connection strings for the chart-managed Secret.                                                              |
| `extraEnv` / `extraEnvFrom`             | `[]`                                       | Extra `env` / `envFrom` entries for every server pod.                                                         |
| `web/worker/realtime.replicas`          | `1`                                        | Replicas per role (see [Scaling](#scaling)).                                                                  |
| `*.autoscaling.enabled`                 | `false`                                    | A CPU-based HorizontalPodAutoscaler per role.                                                                 |
| `*.pdb.enabled`                         | `false`                                    | A PodDisruptionBudget per role.                                                                               |
| `*.resources`, `*.nodeSelector`, …      | see values                                 | Per-role scheduling; the health probes are overridable per role too.                                          |
| `migrations.enabled`                    | `true`                                     | Run migrations in a Job (see [Migrations](#migrations-and-upgrades)).                                         |
| `persistence.*`                         | 2 Gi RWO PVC                               | Uploads volume for `web` when S3 is not configured.                                                           |
| `ingress.*`                             | disabled                                   | Host, extra hosts, TLS, class and annotations; `ingress.realtime` for `/socket.io`.                           |
| `postgresql.enabled` / `redis.enabled`  | `false`                                    | Bundled single-pod Postgres 16 / Redis 7 (official images).                                                   |
| `probes.agents`                         | `[]`                                       | Probe agent Deployments, one per location.                                                                    |
| `podSecurityContext`, `securityContext` | non-root uid 1001, no capabilities         | Pod and container security settings.                                                                          |

## Health checks

| Role       | Startup                             | Readiness         | Liveness                                     |
| ---------- | ----------------------------------- | ----------------- | -------------------------------------------- |
| `web`      | `GET /api/health`, up to 10 minutes | `GET /api/health` | `GET /api/health`, 6 failures × 20 s         |
| `realtime` | –                                   | `GET /healthz`    | `GET /healthz`                               |
| `worker`   | –                                   | –                 | – (a failing worker exits and is restarted)  |
| `all`      | `GET /api/health`, up to 10 minutes | `GET /api/health` | `entrypoint.sh healthcheck` (web + realtime) |

`/api/health` also checks the database, so a database outage takes `web` out of the Service. The liveness
threshold (two minutes) keeps short outages from restarting every web pod; raise it if your database
fails over more slowly. The long startup window covers the first install, when `web` waits for the
migration Job.

## Migrations and upgrades

Migrations run in a Job (`entrypoint.sh migrate`), never in the web pods (`SKIP_MIGRATIONS=true`):

- **`helm install`**: a regular Job named `<release>-migrate-1`. It retries (`migrations.backoffLimit`)
  until the database accepts connections, which covers a bundled Postgres that starts in the same
  release. `web` stays unready until the schema exists; the worker waits for it as well
  (`WORKER_SCHEMA_WAIT_MS`, then a restart).
- **`helm upgrade`**: a `pre-upgrade` hook. Helm runs it with the new image **before** it updates any
  Deployment, and aborts the upgrade if it fails, so new pods only ever start against a migrated schema
  and the old pods keep serving while the Job runs, as they do while `web` migrates in the compose
  stack.

The hook runs before Helm updates the chart's own resources, so it reads the Secret of the **previous**
release. Changing `DATABASE_URL` and the image in the same upgrade migrates the old database; change the
connection first, then upgrade the version. MongoDB has no migrations: the Job finishes immediately and
indexes are created when the processes start.

With `migrations.enabled=false` the `web` pod migrates on start instead, as in the compose stack; the chart
then refuses more than one web replica. Argo CD and Flux render the chart with `helm template`, where every
sync looks like an install: add `migrations.annotations` such as `argocd.argoproj.io/hook: PreSync` and
`argocd.argoproj.io/hook-delete-policy: BeforeHookCreation` so the Job runs before each sync.

Rollbacks (`helm rollback`) do not run the Job; a schema migrated by a newer version stays migrated. Take a
database backup before upgrading across minor versions and read the release notes.

## Ingress and realtime

The browser opens socket.io on the page's own origin at `/socket.io`, with the `payload-token` cookie, so
`/socket.io` must be served on **the same host** as the UI and reach the realtime Service; everything else
goes to `web`. The chart renders two Ingress objects for the same host: `<release>-web` (`/`) and
`<release>-realtime` (`/socket.io`, longest prefix wins), so the realtime path can carry its own
annotations. Controllers that create one load balancer per Ingress (GKE's built-in controller) need both
paths in one object: set `ingress.realtime.separate: false`.

- **WebSockets**: ingress-nginx and Traefik pass upgrades through without configuration. Raise idle
  timeouts for the realtime path (nginx: `proxy-read-timeout` / `proxy-send-timeout` of `3600`), or idle
  dashboards reconnect every minute.
- **Cookies and origins**: `serverUrl` must match the browser URL exactly (scheme, host and port), or the
  CSRF/CORS allow-list rejects the auth cookie and every request after login fails with 403. Additional
  origins that call the API with the cookie go into `config.ADDITIONAL_ORIGINS`.
- **Client addresses**: enable **Trust proxy headers** in the instance settings once Marmot is only reachable
  through the ingress ([Security](Security.md#client-addresses-and-trustproxy)).
- **Sticky sessions**: more than one realtime replica needs them, because socket.io's polling handshake has
  to reach the same pod. With ingress-nginx:

  ```yaml
  ingress:
    realtime:
      annotations:
        nginx.ingress.kubernetes.io/affinity: cookie
        nginx.ingress.kubernetes.io/session-cookie-name: marmot-rt
  ```

  Without a sticky ingress keep `realtime.replicas: 1`.

### TLS and custom status-page domains

For Marmot's own host, cert-manager is the usual choice: `cert-manager.io/cluster-issuer` in
`ingress.annotations` and a `tls` entry with the host.

[Custom domains](Status-Pages.md#custom-domains) of status pages are plain extra hosts that point at the
same backends; `web` picks the page from the `Host` / `X-Forwarded-Host` header. Two ways to get
certificates for them:

- **Known domains**: list them in `ingress.extraHosts` and in a `tls` entry (one certificate with several
  names, or one entry per domain). cert-manager issues them with HTTP-01 once their DNS points at the
  ingress. A wildcard (`*.status.example.com`, DNS-01) covers status pages on subdomains of one zone.
- **Domains added at runtime**: an ingress cannot obtain certificates for hostnames it does not know about.
  Put Caddy with on-demand TLS in front (a Deployment with the Caddyfile from
  [Status pages](Status-Pages.md#custom-domains), `ask http://<release>-web:3000/api/status-pages/resolve-domain`,
  upstreams `<release>-web:3000` and `<release>-realtime:3001`, exposed with a `LoadBalancer` Service) and
  leave `ingress.enabled` off. Caddy then issues a certificate on the first request for any hostname of a
  published page and refuses all others.

## Scaling

The figures in [Deployment](Deployment.md#scaling) and [Sizing](Deployment.md#sizing) apply unchanged:

- **Workers**: one replica per ~25 checks/s with `WORKER_CONCURRENCY` at 10–20 (`config.WORKER_CONCURRENCY`).
  `worker.autoscaling` scales on CPU, which tracks the check rate well.
- **Web**: stateless apart from uploads. Several replicas need S3 (`config.S3_BUCKET` plus credentials in
  the Secret) or a ReadWriteMany `persistence.storageClass`. With the default ReadWriteOnce volume, `web`
  updates with the `Recreate` strategy (a short gap during upgrades); set `web.strategy` to override.
- **Realtime**: see sticky sessions above.
- **Redis** must run with `maxmemory-policy noeviction` and persistence; the bundled one does both. Check
  your managed Redis' eviction policy.

## Single pod (`mode: all`)

`mode: all` runs one `MARMOT_ROLE=all` pod (web, worker and realtime in one container) behind the same
Services and Ingress. It is always a single replica; use it to keep a small install small.

## Probe agents

Each entry in `probes.agents` becomes a Deployment with `MARMOT_ROLE=probe`. Agents only receive
`MARMOT_URL` (default `serverUrl`) and their location token, never the server secrets:

```yaml
probes:
  agents:
    - name: dc-west
      existingSecret: marmot-probe-dc-west # key MARMOT_PROBE_TOKEN (tokenKey to change)
      env:
        - name: WORKER_CONCURRENCY
          value: '5'
```

A probe agent usually runs in another cluster than Marmot (that is its point). There, install the chart
with `mode: probes`: it deploys only the agents, without web, worker, realtime, migrations, databases or
ingress.

```bash
kubectl -n marmot-probe create secret generic marmot-probe-dc-west --from-literal=MARMOT_PROBE_TOKEN=mp_...
helm install marmot-probe oci://ghcr.io/thinkhumandotdev/charts/marmot -n marmot-probe \
  --set mode=probes --set serverUrl=https://status.example.com \
  --set 'probes.agents[0].name=dc-west' --set 'probes.agents[0].existingSecret=marmot-probe-dc-west'
```

Use the same chart version as the server, so agent and server speak the same wire format.

## MongoDB

Set `database.adapter: mongodb` and point `DATABASE_URL` at a replica set (Atlas or an operator); the chart
has no bundled MongoDB.

## Network access of the checks

- **Ping monitors** run `ping` as the unprivileged `marmot` user, which needs unprivileged ICMP sockets. If
  ping checks fail with a permission error, allow them for the pod's group with the safe sysctl:

  ```yaml
  podSecurityContext:
    sysctls:
      - name: net.ipv4.ping_group_range
        value: '0 2147483647'
  ```

- **Docker monitors** with a socket host are off (`DOCKER_SOCKET_ENABLED=false`); mount a socket with
  `extraVolumes` / `extraVolumeMounts` and turn it back on only if you mean it.
- **NetworkPolicies**: workers need egress to everything they monitor; web, worker and realtime need the
  database and Redis.

## Backups

Back up the database as for any other deployment ([Deployment](Deployment.md#backups-and-restore)). With the
bundled Postgres:

```bash
kubectl -n marmot exec marmot-postgresql-0 -- pg_dump -U marmot -Fc marmot > marmot-$(date +%F).dump
```

`helm uninstall` keeps the uploads PVC, the bundled databases' PVCs (StatefulSet volumes) and the bundled
Postgres password Secret, so a reinstall with the same release name finds its data again. Delete them by
hand to start over.

## Troubleshooting

- `web` never gets ready on install: `kubectl logs job/<release>-migrate-1`. Usually `DATABASE_URL` is
  wrong or the database refuses the connection.
- `helm upgrade` fails with `pre-upgrade hooks failed`: the migration failed and nothing was rolled out;
  `kubectl logs job/<release>-migrate-<revision>` (failed hook Jobs are kept).
- Live updates missing: `curl https://status.example.com/socket.io/?EIO=4\&transport=polling` must return a
  `sid`. If it returns the Marmot 404 page, the `/socket.io` path goes to `web`.
- 403 after login: `serverUrl` differs from the URL in the browser.
