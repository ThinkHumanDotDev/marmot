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

## Creating the template (maintainers, once)

The service **names matter**: `edge` dials `web.railway.internal` and `realtime.railway.internal`, and the
variables below reference `edge`, `redis` and `Postgres` by name.

1. In a new Railway project, add **Postgres** from the database menu. Keep the name `Postgres`.
2. For each of `edge`, `web`, `worker`, `realtime` and `redis`, add a service from the GitHub repo
   `ThinkHumanDotDev/marmot` (branch `main`) and give it that name. Then, in its settings:
   - leave **Root Directory** empty, because the build context is the repository root;
   - set the **config file path** (config as code) to `/deploy/railway/<service>/railway.json`. That file
     selects the Dockerfile, watch paths, healthcheck and restart policy.
3. Add volumes: `web` at `/app/uploads`, `redis` at `/data`.
4. Generate a public domain for `edge` on port **8080**. The other services stay private.
5. Add the variables:

   | Service                     | Variable                 | Value                                                                                       |
   | --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
   | project (shared)            | `PAYLOAD_SECRET`         | `${{secret(64)}}`                                                                           |
   | `redis`                     | `REDIS_PASSWORD`         | `${{secret(32)}}`                                                                           |
   | `web`, `worker`, `realtime` | `PAYLOAD_SECRET`         | `${{shared.PAYLOAD_SECRET}}`                                                                |
   | `web`, `worker`, `realtime` | `NEXT_PUBLIC_SERVER_URL` | `https://${{edge.RAILWAY_PUBLIC_DOMAIN}}`                                                   |
   | `web`, `worker`, `realtime` | `DATABASE_URL`           | `${{Postgres.DATABASE_URL}}`                                                                |
   | `web`, `worker`, `realtime` | `REDIS_URL`              | `redis://default:${{redis.REDIS_PASSWORD}}@${{redis.RAILWAY_PRIVATE_DOMAIN}}:6379?family=0` |

   `?family=0` lets the Redis client resolve IPv6 private hostnames. Everything else (SMTP, OIDC, S3, …) is
   optional and documented in `docs/Configuration.md`.

6. Deploy, open the `edge` domain, and check that:
   - the setup wizard loads;
   - the dashboard updates live, which means the WebSocket reaches realtime through edge;
   - an HTTP monitor goes up;
   - a notification test sends.
7. Create the template from the project (project settings → generate template). Check the variables
   above survived, add a description and the Marmot icon, then **publish** it. Kickback is only paid on
   published templates.
8. Put the button in the README with the template slug and your referral code:

   ```md
   [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/<slug>?referralCode=<code>&utm_medium=integration&utm_source=template&utm_campaign=generic)
   ```

Changing a fixed setting later means editing the files here. Changing the service list or variables means
editing the template on Railway as well; update the tables above when you do.
