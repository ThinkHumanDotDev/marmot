# Railway template

Service images for the official **Deploy on Railway** template. [`.railway/railway.ts`](../../.railway/railway.ts)
declares the project: services, Postgres, volumes, variables, and each service's build and deploy settings.
Railway reads that file only when someone runs `railway config apply`. The small images here carry
everything a deploy reads from the repository: roles, bind addresses, Caddy upstreams and the Marmot
version. `PORT` is a service variable in `.railway/railway.ts`, because Railway injects its own `PORT`
(8080) and that overrides an image's `ENV`. A release therefore reaches running projects and the published template without editing anything
on Railway. Railway's template generator keeps only variables that reference other services, which is
another reason fixed values live in the images.

| Folder      | Railway service | Image                             | Public | Volume         | Notes                                                     |
| ----------- | --------------- | --------------------------------- | ------ | -------------- | --------------------------------------------------------- |
| `edge/`     | `edge`          | Caddy + `docker/Caddyfile`        | ✅     | –              | `/socket.io/*` → realtime, the rest → web; port 8080      |
| `web/`      | `web`           | `ghcr.io/thinkhumandotdev/marmot` | –      | `/app/uploads` | `MARMOT_ROLE=web`, migrations on start, `/api/health`     |
| `worker/`   | `worker`        | same                              | –      | –              | `MARMOT_ROLE=worker`; scale with replicas                 |
| `realtime/` | `realtime`      | same                              | –      | –              | `MARMOT_ROLE=realtime`, `/healthz` on 3001                |
| `redis/`    | `redis`         | `redis:7-alpine`                  | –      | `/data`        | `noeviction`, persistence, password from `REDIS_PASSWORD` |
| –           | `Postgres`      | Railway's Postgres                | –      | (managed)      | Add it from Railway's database menu                       |

The Marmot image tag in `web/`, `worker/` and `realtime/` follows `package.json`. `scripts/release.sh` bumps
it. `pnpm check:railway`, which runs in CI, fails when:

- a Dockerfile or its tag is out of line;
- `.railway/railway.ts` and the folders here disagree.

`BIND_HOST` (web listening on IPv6 as well as IPv4) arrived after `0.1.0`. Publish the template once a
release containing it is out. Before that, `web` listens on IPv4 only, and edge cannot reach it on an
IPv6-only private network.

## Creating the project and template (maintainers, once)

[`.railway/railway.ts`](../../.railway/railway.ts) declares the whole project with Railway's infrastructure
as code: Postgres, the five services (each built from its Dockerfile here, with healthchecks and restart
policy), the volumes and every variable. One command creates it:

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
`railway config apply`. Set the same `MARMOT_BRANCH` and `MARMOT_REGION` as the first run; the region
defaults to `europe-west4-drams3a`. Stored secrets are kept (`preserve()`).

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
   - check the other variables survived. The references should be there; `PORT` (3000 on `web`, 3001 on
     `realtime`, 8080 on `edge`) is a literal, so re-add it if the generator dropped it;
   - add a description and the Marmot icon;
   - **publish** it. Kickback is only paid on published templates.
3. Put the button in the README with the template slug and your referral code:

   ```md
   [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/<slug>?referralCode=<code>&utm_medium=integration&utm_source=template&utm_campaign=generic)
   ```

### Manual setup (if the IaC beta gets in the way)

The service **names matter**: `edge` dials `web.railway.internal` and `realtime.railway.internal`, and the
variables reference `edge`, `redis` and `Postgres` by name.

1. Add **Postgres** from the database menu.
2. Add `edge`, `web`, `worker`, `realtime` and `redis` from the GitHub repo `ThinkHumanDotDev/marmot`. For
   each, leave **Root Directory** empty. Under Build, choose the Dockerfile builder with path
   `deploy/railway/<service>/Dockerfile`. Set the healthcheck path to `/api/health` on `web` and `/healthz` on
   `realtime`.
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

Changing a fixed setting later means editing the images here. Changing services, build settings or
variables means editing `.railway/railway.ts`, running `railway config apply`, and updating the published
template on Railway.
