# Railway template

Config for the official **Deploy on Railway** template. Every fixed setting lives here: build, healthchecks,
restart policy, ports, roles, bind addresses and Caddy upstreams. The template on Railway only wires the
services together and generates secrets, so a Marmot release never needs a manual template edit. Railway's
template generator keeps only variables that reference other services, which is why fixed values are
baked into these small images instead.

| Folder      | Railway service | Image                             | Public | Volume         | Notes                                                     |
| ----------- | --------------- | --------------------------------- | ------ | -------------- | --------------------------------------------------------- |
| `edge/`     | `edge`          | Caddy + `docker/Caddyfile`        | ✅     | –              | `/socket.io/*` → realtime, the rest → web; port 8080      |
| `web/`      | `web`           | `ghcr.io/thinkhumandotdev/marmot` | –      | `/app/uploads` | `MARMOT_ROLE=web`, migrations on start, `/api/health`     |
| `worker/`   | `worker`        | same                              | –      | –              | `MARMOT_ROLE=worker`; scale with replicas                 |
| `realtime/` | `realtime`      | same                              | –      | –              | `MARMOT_ROLE=realtime`, `/healthz` on 3001                |
| `redis/`    | `redis`         | `redis:7-alpine`                  | –      | `/data`        | `noeviction`, persistence, password from `REDIS_PASSWORD` |
| –           | `Postgres`      | Railway's Postgres                | –      | (managed)      | Add it from Railway's database menu                       |

The Marmot image tag in `web/`, `worker/` and `realtime/` follows `package.json`. `scripts/release.sh` bumps
it, and `pnpm check:railway` (run in CI) fails when a Dockerfile, `railway.json` or tag is out of line.

`BIND_HOST` (web listening on IPv6 as well as IPv4) arrived after `0.1.0`. Publish the template once a
release containing it is out. Before that, `web` listens on IPv4 only, and edge cannot reach it on an
IPv6-only private network.

## Creating the project and template (maintainers, once)

[`.railway/railway.ts`](../../.railway/railway.ts) declares the whole project with Railway's infrastructure
as code: Postgres, the five services (each reading its `railway.json` here), the volumes and every
variable. One command creates it:

```bash
npm i -g @railway/cli        # 5.42.1 or newer
railway login
pnpm install
pnpm railway:bootstrap                                             # deploys from main
# MARMOT_BRANCH=feat/railway-template PROJECT_NAME=marmot-test pnpm railway:bootstrap
```

The script:

1. creates a new project and links this checkout to it;
2. generates `PAYLOAD_SECRET` and `REDIS_PASSWORD` with `openssl`;
3. runs `railway config apply`;
4. generates the `edge` domain on port 8080;
5. redeploys the Marmot services so they pick up the domain.

To change the project later, edit `.railway/railway.ts` and run `railway config plan`, then
`railway config apply`. Stored secrets are kept (`preserve()`).

Then:

1. Open the `edge` domain and check that:
   - the setup wizard loads;
   - the dashboard updates live, which means the WebSocket reaches realtime through edge;
   - an HTTP monitor goes up;
   - a notification test sends.
2. Generate the template from the project in the Railway dashboard. In the template editor:
   - set `PAYLOAD_SECRET` on `web` and `REDIS_PASSWORD` on `redis` to `${{secret(64)}}`, so every deployment
     generates its own secrets. Railway drops literal values from generated templates, and the values
     from step 2 must never be shared;
   - check the other variables survived (they are references, which it keeps);
   - add a description and the Marmot icon;
   - **publish** it. Kickback is only paid on published templates.
3. Put the button in the README with the template slug and your referral code:

   ```md
   [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/<slug>?referralCode=<code>&utm_medium=integration&utm_source=template&utm_campaign=generic)
   ```

`pnpm check:railway`, which runs in CI, evaluates `.railway/railway.ts`. It fails when a service folder here
and the IaC file disagree.

### Manual setup (if the IaC beta gets in the way)

The service **names matter**: `edge` dials `web.railway.internal` and `realtime.railway.internal`, and the
variables reference `edge`, `redis` and `Postgres` by name.

1. Add **Postgres** from the database menu.
2. Add `edge`, `web`, `worker`, `realtime` and `redis` from the GitHub repo `ThinkHumanDotDev/marmot`. For
   each, leave **Root Directory** empty and set the **config file path** to
   `/deploy/railway/<service>/railway.json`.
3. Add volumes: `web` at `/app/uploads` and `redis` at `/data`. Generate a domain for `edge` on port 8080.
4. Add the variables:

   | Service                     | Variable                 | Value                                                                                       |
   | --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
   | `redis`                     | `REDIS_PASSWORD`         | `${{secret(64)}}`                                                                           |
   | `web`                       | `PAYLOAD_SECRET`         | `${{secret(64)}}`                                                                           |
   | `worker`, `realtime`        | `PAYLOAD_SECRET`         | `${{web.PAYLOAD_SECRET}}`                                                                   |
   | `web`, `worker`, `realtime` | `NEXT_PUBLIC_SERVER_URL` | `https://${{edge.RAILWAY_PUBLIC_DOMAIN}}`                                                   |
   | `web`, `worker`, `realtime` | `DATABASE_URL`           | `${{Postgres.DATABASE_URL}}`                                                                |
   | `web`, `worker`, `realtime` | `REDIS_URL`              | `redis://default:${{redis.REDIS_PASSWORD}}@${{redis.RAILWAY_PRIVATE_DOMAIN}}:6379?family=0` |

   `?family=0` lets the Redis client resolve IPv6 private hostnames. Everything else (SMTP, OIDC, S3, …) is
   optional and documented in `docs/Configuration.md`.

Changing a fixed setting later means editing the files here. Changing the service list or variables means
editing `.railway/railway.ts` and the published template on Railway.
