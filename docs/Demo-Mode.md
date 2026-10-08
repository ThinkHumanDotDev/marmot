# Demo mode

A demo instance lets people try Marmot without installing anything: it seeds a realistic dataset, lets
visitors click around with a shared account and wipes everything on a schedule. Nothing it does reaches the
outside world. Demo mode is **off by default**. Turn it on only on an instance that holds nothing else:
every reset deletes **all** data.

## Try it locally

```bash
docker compose -f docker/docker-compose.demo.yml up -d --wait
```

Open <http://localhost:8080> and sign in as `demo@example.com` with the password `marmot-demo` (the login
page shows and pre-fills both). `docker compose -f docker/docker-compose.demo.yml down -v` removes it
again. From a checkout, `DEMO_MODE=true pnpm dev` against an empty database does the same.

## Configuration

| Variable                      | Default | Description                                                                                       |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `DEMO_MODE`                   | `false` | Run as a self-resetting demo.                                                                     |
| `DEMO_RESET_INTERVAL_MINUTES` | `60`    | Minutes between two resets (15 to 10080).                                                         |
| `DEMO_MODE_FORCE`             | `false` | Start even though the database holds accounts other than the demo accounts, and **wipe** it then. |

## The dataset

Every reset recreates the same data (`src/server/demo/dataset.ts`):

- the organization **Example Inc.** (slug `demo`) with the demo account as owner and three colleagues
  (admin, member, viewer) nobody can sign in as;
- about twenty monitors of a dozen types in three groups (Website, Public API, Infrastructure), with tags,
  a paused monitor, a push monitor and a manual one; two of them are checked from three simulated probe
  locations (Frankfurt, Virginia, Singapore) with a quorum;
- notification channels (Slack, Discord, webhook) that point at the sink;
- two status pages: **Example Inc. Status** (`/status/example-status`) with an active incident and a
  resolved one with a full update timeline, and **Example Inc. Platform** (`/status/example-internal`);
- maintenance: a running window (Staging API), a scheduled database upgrade and a weekly patch window;
- resolved on-call incidents, and 90 days of history: heartbeats and the minutely, hourly, daily and
  per-location roll-ups, with response-time histograms (percentiles) and request timing phases.

Targets use reserved names only (`example.com`, `.invalid`, 192.0.2.0/24).

## Simulated checks

A demo instance never connects to a monitor's target. The worker replaces every check (except push, manual
and group monitors, which never leave the instance anyway) with a simulated result: response times around
the monitor's profile with a business-hours swell and rare spikes, the Search API down a few minutes every
two hours, the Payments API slow during its "settlement batch". The results are a deterministic function of
monitor, location and minute, and the history back-fill uses the same function, so live beats continue the
seeded charts. A `demo-probes` job plays the probe agents of the seeded locations every minute through the
normal ingest path, so quorums, the location table and the probes' online status keep working.

Monitors visitors create get a default profile and a message saying the check was simulated.

## Guard rails

| What                                                    | In demo mode                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Notifications (every provider, test messages, SMS)      | Rendered as usual, then logged to the sink (`demoSink` log lines) instead of sent.                 |
| Email (invitations, subscriber mail, password reset, …) | The email adapter is the sink, whatever `SMTP_*` says. The SMTP test route answers 403.            |
| Outbound and subscriber webhooks                        | Logged to the sink. Webhook endpoints cannot be created.                                           |
| Any other outbound connection                           | The outbound address guard refuses every target before resolving it (`Blocked: … (DEMO_MODE)`).    |
| Monitor targets                                         | Never contacted (simulated checks); the domain expiry lookup is off; Docker host tests answer 403. |
| Demo account                                            | Password, email, password reset, account deletion and two-factor setup are refused.                |
| Signups and first-run setup                             | Off.                                                                                               |
| API keys, SSO connections and domains, SSO enforcement  | Refused.                                                                                           |
| Uploads (logos, avatars, favicons), custom domains      | Refused.                                                                                           |
| Imports (Marmot, Uptime Kuma, subscriber CSV), billing  | Refused.                                                                                           |
| Instance settings                                       | Read-only.                                                                                         |

Refusals answer `403` with `errors[0].data = { code: 'demo_mode', feature }`. They are collection hooks
(`src/server/demo/guards.ts`), so the Marmot routes, the Payload REST/GraphQL API, the admin panel and the
MCP server all hit them.

## Resets

The worker resets on boot and then every `DEMO_RESET_INTERVAL_MINUTES` through the `demo-reset` job
scheduler on the `marmot:maintenance` queue (`src/server/demo/reset.ts`): it deletes every row of every
collection (except the migration journal) in batches (`deleteInBatches`), reseeds the dataset and rebuilds
the check schedulers. A reset takes well under a minute; signed-in visitors are signed out by it. A Redis
lock and a one-minute debounce keep resets of several workers from overlapping, and a reset interrupted
half way is completed by the next one. A banner on every page counts down to the next reset.

**Safety.** Every process refuses to start in demo mode when the database holds an account that is not one
of the demo accounts, and every reset checks again, so pointing a demo at a real database by mistake
deletes nothing. `DEMO_MODE_FORCE=true` overrides this (and wipes that database). An instance started
without `DEMO_MODE` removes a leftover reset scheduler on boot, and the job does nothing outside demo mode.
