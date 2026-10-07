# Probe locations

By default every check runs on Marmot's own workers, so every check comes from the network Marmot runs
in. A **probe location** runs checks somewhere else: inside a private network (a VPC, an office, a homelab
behind NAT) without exposing Marmot there, or from a second vantage point for public services.

A location is served by a **probe agent**: the Marmot image started with `MARMOT_ROLE=probe`. The agent
connects **outbound only** to Marmot over HTTPS, pulls the monitors assigned to its location, runs them
with the same check implementations as the workers, and pushes the results back. It needs no database,
no Redis and no inbound port.

```
   private network                           Marmot
  ┌──────────────────────┐   HTTPS (out)   ┌──────────────────────────────┐
  │ probe agent ─────────┼────────────────▶│ GET  /api/probe/v1/config    │
  │   │ checks           │                 │ POST /api/probe/v1/results   │
  │   ▼                  │                 │   → heartbeats, alerts, stats│
  │ db:5432, intranet…   │                 └──────────────────────────────┘
  └──────────────────────┘
```

## Set up a location

1. **Settings → Locations → New location** (admins and owners). Give it a name, optionally a slug and up
   to 20 labels (`region: eu-west`). `local` is reserved: it names the workers of the Marmot server.
2. Copy the **token** (`mp_…`). It is shown once; Marmot stores only its SHA-256. If you lose it, rotate
   it.
3. Start an agent where the checks should run:

   ```sh
   docker run -d --name marmot-probe --restart unless-stopped \
     -e MARMOT_ROLE=probe \
     -e MARMOT_URL=https://marmot.example.com \
     -e MARMOT_PROBE_TOKEN=mp_xxxxxxxx_... \
     ghcr.io/thinkhumandotdev/marmot:latest
   ```

   or with compose: `docker/docker-compose.probe.yml` (set `MARMOT_URL` and `MARMOT_PROBE_TOKEN`).

4. Edit a monitor and pick the location under **Check location**. The agent picks the monitor up within
   one refresh cycle (at most a minute) and its heartbeats start arriving.

The location's badge in **Settings → Locations** turns **Online** once the agent called in, shows when it
was last seen and which host and version the agent runs. A monitor checked by a location shows
"Checked from <location>" on its page.

The probe uses the same image as the server: there is no separate image tag. Use the same version as the
server so both speak the same wire format.

### Raspberry Pi and other small hosts

The image is published for `linux/amd64` and `linux/arm64`, so a Raspberry Pi 4/5 (or any 64-bit ARM board)
with a 64-bit OS runs the same `docker run` command. The agent is a single Node.js process without a
database or Redis. Lower `WORKER_CONCURRENCY` (checks at once, default 10) on very small boards, and keep the clock synchronised (NTP): results carry the time they were taken and results
older than ten minutes are refused. 32-bit ARM (`armv7`) is not supported.

Without Docker, run it from a checkout: `pnpm install && pnpm build:server`, then
`MARMOT_URL=… MARMOT_PROBE_TOKEN=… pnpm start:probe` (Node.js 22).

## What runs where

- A monitor without a location is checked by the workers of the Marmot server (the implicit `local`
  location). A monitor with a location is checked **only** by that location's agents: the workers keep no
  schedule for it.
- One location per monitor for now. Checking one monitor from several locations with a quorum is planned
  (#92); heartbeats already record the location that produced them.
- Group, manual, push and Steam monitors run on the server only (they are computed by the server, wait for
  requests that reach it, or need the instance's Steam key).
- Proxies and Docker hosts a monitor uses are sent to the agent with the monitor. A Docker host of type
  `socket` means the Docker daemon of the **probe's** host; mount `/var/run/docker.sock` into the agent.
- The server's private-address guard (`MONITOR_DENY_PRIVATE_ADDRESSES`) does not apply to monitors of a
  probe location: they connect from the probe's network, which the agent's own `MONITOR_*` settings govern.
- Maintenance windows, retries, upside-down mode, the recovery threshold, notifications, incidents and the
  uptime statistics work exactly as for local checks: the server feeds every result through the same state
  machine.
- **Check now** cannot record a result for a probe-checked monitor (it would mix two vantage points); a dry
  run (`record=false`) still tests the target from the server.
- With `CONNECTIVITY_CHECK_ENABLED=true` on the agent, it watches its own uplink like a worker does: while
  the probe's internet is down, checks of external targets are recorded as `checker offline` instead of
  going DOWN ([Configuration → Self connectivity check](Configuration.md#self-connectivity-check)).

## Offline locations

The worker re-evaluates every location every 15 seconds. A location is **offline** when its agent has not
called in for `PROBE_OFFLINE_AFTER` seconds (default 180; agents call in at least every minute). The owners
and admins of the organization get an email when a location goes offline and again when it is back online.
While a location is offline its monitors are not checked, and their status stays as it was.

## Rotate or delete a token

**Rotate token** replaces the token at once: agents using the old one get `401` and stop checking until
they are restarted with the new token. **Delete** removes the location and its token; its monitors move
back to the server's workers. Both are recorded in the audit log (`location.token_rotated`,
`location.deleted`), like creating and editing a location.

## Wire format

Version 1 lives under `/api/probe/v1/`; incompatible changes get a new path. Both endpoints authenticate
with `Authorization: Bearer <token>` and are rate limited per token (`PROBE_RATE_LIMIT`, default 600 per
minute). Agents identify themselves with `User-Agent: marmot-probe/<version>` and the
`X-Marmot-Probe-Hostname` / `X-Marmot-Probe-Platform` headers.

| Endpoint                     | Purpose                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/probe/v1/config`   | The location (`id`, `name`, `slug`), `refreshSeconds`, the assigned active monitors and the proxies and Docker hosts they reference. Carries an `ETag`; `If-None-Match` answers `304`.                                                                                                           |
| `POST /api/probe/v1/results` | `{ results: [{ monitorId, time, ok, status?, msg, ping?, duration?, tlsInfo?, assertions?, checkerOffline? }] }`, at most 100 per request, in order. Answers `{ accepted, results: [{ monitorId, accepted, reason?, status?, nextCheckSeconds? }] }`; refused reasons tell the agent to refresh. |

Results not newer than the monitor's last check are refused as `duplicate`, so an agent can safely re-send a
batch whose response it lost; undelivered results wait in the agent (up to 1,000) while Marmot is
unreachable.
