# Host monitoring

_(landing in the current release, #136)_ A **Host (agent)** monitor watches the machine a service runs
on: CPU, load, memory, swap, disks, network throughput, temperatures and, optionally, every Docker
container's CPU and memory. A small agent on the machine pushes a sample to Marmot every interval; Marmot
judges the monitor's thresholds and marks it DOWN or degraded with a message such as
`disk / at 93 % (> 90 %)`, before the HTTP check of the service fails. No separate metrics stack is
needed.

The agent only makes outbound HTTPS requests to Marmot. It opens no port and needs no database, Redis or
secret besides the monitor's token.

## Set up a host

1. **Monitors → New monitor**, type **Host (agent)**. The interval (default 60 s) is how often the agent
   reports. A new host monitor starts with three thresholds (any disk over 90 % is DOWN, CPU or memory over
   90 % for 5 minutes is degraded); change them under **Thresholds**.
2. Save. The monitor page shows a **Host agent** card with the token and ready-to-copy commands.
3. Start the agent on the machine with one of them. The first sample arrives a few seconds after it starts;
   from then on one per interval (the agent follows the monitor's interval, so changing it in Marmot is
   enough).

### Docker

The agent is a role of the Marmot image (`MARMOT_ROLE=host-agent`), like the [probe agent](Probe-Locations.md).
Mount the host's root read-only and point `HOST_AGENT_ROOT` at it, so the agent reports the host rather than
its own container:

```bash
docker run -d --name marmot-host-agent --restart unless-stopped \
  --network host --pid host \
  -v /:/host:ro,rslave -e HOST_AGENT_ROOT=/host \
  -e MARMOT_ROLE=host-agent \
  -e MARMOT_URL=https://marmot.example.com \
  -e MARMOT_HOST_TOKEN=<token> \
  ghcr.io/thinkhumandotdev/marmot:latest
```

`docker/docker-compose.host-agent.yml` does the same and also reads per-container stats through the Docker
socket:

```bash
MARMOT_URL=https://marmot.example.com MARMOT_HOST_TOKEN=<token> DOCKER_GID=$(stat -c %g /var/run/docker.sock) \
  docker compose -f docker-compose.host-agent.yml up -d
```

The image runs as an unprivileged user; `DOCKER_GID` gives it the group that owns the socket. The socket
grants full access to the Docker daemon; leave it out (and `HOST_AGENT_DOCKER` off) to go without container
stats.

### Without Docker (Linux, macOS, Windows)

The agent is a single self-contained JavaScript file that runs on Node.js 20 or later, without
`node_modules`. Copy it out of the image (or a release's `dist/server/host-agent.mjs`) and run it as a
service (systemd, launchd, NSSM):

```bash
docker run --rm --entrypoint cat ghcr.io/thinkhumandotdev/marmot:latest /app/dist/server/host-agent.mjs > marmot-host-agent.mjs
MARMOT_ROLE=host-agent MARMOT_URL=https://marmot.example.com MARMOT_HOST_TOKEN=<token> node marmot-host-agent.mjs
```

From a checkout, `pnpm dev:host-agent` runs it from source.

### Agent settings

| Variable                   | Default                | Description                                                                                                  |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MARMOT_ROLE`              | —                      | `host-agent`.                                                                                                |
| `MARMOT_URL`               | —                      | Required: the Marmot server.                                                                                 |
| `MARMOT_HOST_TOKEN`        | —                      | Required: the monitor's token (monitor page → **Host agent**).                                               |
| `HOST_AGENT_INTERVAL`      | `60`                   | Seconds between samples until Marmot answers with the monitor's interval (10–3600).                          |
| `HOST_AGENT_DISKS`         | `/`                    | Mount points to report, comma-separated, e.g. `/,/var/lib/docker`. On Windows every drive letter by default. |
| `HOST_AGENT_DOCKER`        | `false`                | Report every running container's CPU and memory through the Docker Engine API.                               |
| `HOST_AGENT_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker daemon socket (`//./pipe/docker_engine` on Windows).                                                  |
| `HOST_AGENT_ROOT`          | —                      | Prefix of the host's `/proc`, `/sys`, `/etc` and mount points when the agent runs in a container (`/host`).  |
| `LOG_LEVEL`                | `info`                 | `debug` logs every delivered sample.                                                                         |

## What the agent reports

| Metric                     | Series                                       | Linux                                  | macOS                    | Windows                  |
| -------------------------- | -------------------------------------------- | -------------------------------------- | ------------------------ | ------------------------ |
| CPU busy, all cores        | `cpu` (%)                                    | yes                                    | yes                      | yes                      |
| Load average 1/5/15 min    | `load1` … `load15`                           | yes                                    | yes                      | —                        |
| Memory used (and total)    | `memory` (%)                                 | `MemTotal − MemAvailable`, like `free` | yes                      | yes                      |
| Swap used (and total)      | `swap` (%)                                   | yes                                    | `vm.swapusage`           | —                        |
| Disk used per mount point  | `disk:<mount>` (%)                           | yes, like `df`                         | yes                      | yes                      |
| Network in / out           | `net:rx`, `net:tx`                           | all interfaces but loopback            | `netstat -ib`            | —                        |
| Temperatures               | `temp:<sensor>` °C                           | `/sys/class/hwmon` or `thermal_zone`   | —                        | —                        |
| Uptime, OS, CPU count      | (host summary)                               | yes                                    | yes                      | yes                      |
| Per-container CPU / memory | `docker.cpu:<name>`, `docker.mem:<name>` (%) | with `HOST_AGENT_DOCKER`               | with `HOST_AGENT_DOCKER` | with `HOST_AGENT_DOCKER` |

Network and CPU figures are rates between two samples, so the first sample after a start has none.
Container CPU follows `docker stats`: 100 % is one core. Container memory is the share of the
container's limit (the host's memory when it has none), page cache excluded.

**Footprint.** The agent is a Node.js process with no dependencies to install. Its own memory
(anonymous, private pages) is about 17–19 MB; the resident size including the shared Node.js runtime is
about 60 MB. It wakes once per interval and spawns no process on Linux.

## Thresholds

Each threshold compares one metric with a value: `metric`, an optional `target`, `operator` (`>`, `>=`,
`<`, `<=`), `value`, `duration` (seconds) and `severity` (`down` or `degraded`).

- **Target.** Disk, temperature and container thresholds name a mount point, sensor or container; left
  empty they apply to every one, and the message names the worst.
- **Duration.** `0` judges the newest sample. A duration (up to 6 hours) needs every sample of that
  period to breach, judged on the minutely rollups: `cpu > 90 for 300` is a sustained 5 minutes, and a
  single sample under 90 % clears it.
- **Severity.** `down` marks the monitor DOWN (retries and notifications as for any check); `degraded`
  marks it [degraded](Monitors.md) (notified only on channels that opted into degraded events). DOWN wins
  when both breach.

The check runs every interval: a breach shows up at the latest one interval after the sample that caused
it, and the heartbeat message lists every breached threshold, e.g.
`disk / at 93 % (> 90 %); CPU at 97 % for 5 min (> 90 %)`. Without a breach the message summarises the host
(`CPU 12 %, memory 48 %, disk / 61 %`).

## Missed samples

Like a push monitor, a host monitor goes DOWN when no sample arrives within the interval plus the grace
period: `No metrics received for 3 min`. The grace period is the monitor's **Grace period** setting, by
default 10 % of the interval. A new monitor is PENDING until the first sample arrives (for one interval
plus grace). Pausing the monitor makes the endpoint answer `409`; the agent keeps running and resumes
reporting when the monitor is resumed.

## Storage

Samples are folded into the `host-metrics` collection: one row per monitor, granularity (`minute`,
`hour`, `day`) and bucket, holding `[count, sum, min, max, last]` for every series. Minutely rows also keep
the newest sample for the host summary and are deleted after 24 hours, hourly rows after 30 days and
daily rows with the data period, like the monitor statistics. No raw sample is kept beyond a day. The rows
are deleted with their monitor.

## API

`POST /api/agent/v1/metrics` with `Authorization: Bearer <token>` and a JSON sample:

```json
{
  "hostname": "web-1",
  "platform": "linux",
  "os": "Debian GNU/Linux 12",
  "agentVersion": "0.9.0",
  "uptime": 86400,
  "cpus": 4,
  "cpu": 12.5,
  "load": [0.4, 0.3, 0.2],
  "memory": { "used": 4294967296, "total": 17179869184 },
  "swap": { "used": 0, "total": 2147483648 },
  "disks": [{ "mount": "/", "used": 32212254720, "total": 53687091200 }],
  "network": { "rx": 12000, "tx": 3400 },
  "temperatures": [{ "name": "coretemp Package id 0", "celsius": 54 }],
  "containers": [
    {
      "name": "web",
      "state": "running",
      "cpu": 3.2,
      "memoryUsed": 104857600,
      "memoryLimit": 1073741824
    }
  ]
}
```

Only `hostname` is required; every other field may be left out or `null`. Bytes are bytes, `network` is
bytes per second, `cpu` is a percentage. The answer is `{ "ok": true, "interval": 60 }`; errors are
`401` (unknown token, or not a host monitor), `409` (monitor paused), `400` (malformed sample), `413`
(over 256 KB) and `429` with `Retry-After` beyond `HOST_AGENT_RATE_LIMIT` samples per minute per monitor
(default 30). Any script that produces this JSON can feed a host monitor.
