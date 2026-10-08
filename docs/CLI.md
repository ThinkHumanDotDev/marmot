# Command-line tool and monitors as code

`marmot` is Marmot's command-line tool. It keeps monitor definitions in a YAML (or JSON) file that you
review in pull requests and apply to staging and production, and it answers quick questions from the
terminal: what is down, what did this monitor report, is this URL up right now.

The CLI only talks to the [management API](Integrations.md#management-api) over HTTP with an
organization API key. It never connects to the database, so it works against any Marmot instance you can
reach, including the hosted one.

## Install

The CLI is one self-contained JavaScript file, `dist/cli/marmot.mjs`, built with the server bundles
(`pnpm build:server`) and shipped in the Docker image. It needs Node.js 20 or later and nothing else.

| Where                  | How to run it                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Marmot container       | `docker compose exec web node dist/cli/marmot.mjs status`                           |
| Any machine or CI job  | copy `dist/cli/marmot.mjs` (from a checkout or the image) and run `node marmot.mjs` |
| A checkout of the repo | `pnpm build:server && node dist/cli/marmot.mjs …`, or `pnpm -s marmot …` (sources)  |

`package.json` declares it as the `marmot` bin, so `pnpm link --global` in a checkout puts `marmot` on your
`PATH`. The repository stays a single package: the CLI lives in `src/cli/` next to the code it shares
(the monitor zod schemas, the message catalogue) and is bundled with the existing esbuild script.

## Connect

Create an API key under **Settings → API keys** (an admin or owner can). A `read` key is enough for
`status`, `list`, `info`, `logs`, `import` and `plan`; `apply`, `check`, `pause`/`resume`, incidents and
maintenance need a `write` key. The organization id is the number (or MongoDB id) in the management API
URLs, shown on the API keys page.

The CLI reads the connection from, in this order: the flags `--url`, `--api-key`, `--org`; the environment
variables below; the profile saved by `marmot login`.

| Variable         | Description                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `MARMOT_URL`     | Base URL of the instance, e.g. `https://status.example.com`.                                                             |
| `MARMOT_API_KEY` | Organization API key (`mk_…`).                                                                                           |
| `MARMOT_ORG`     | Organization id.                                                                                                         |
| `MARMOT_PROFILE` | Saved profile to use (default: the last one `login` saved, else `default`).                                              |
| `MARMOT_CONFIG`  | Config file (default `$XDG_CONFIG_HOME/marmot/config.json`, i.e. `~/.config/marmot/config.json`).                        |
| `NO_COLOR`       | Any value turns colours off (as `--no-color` does). Colours are also off when stdout is not a terminal or with `--json`. |

These are read by the CLI on your machine, not by the server; they are not part of the
[server configuration](Configuration.md).

```sh
# Check the key and save it (the file is created with mode 0600)
echo "$KEY" | marmot login --url https://status.example.com --org 1 --api-key-stdin
marmot login --url https://staging.example.com --org 3 --api-key mk_… --profile staging
marmot --profile staging status
marmot config     # what would be used, with the key masked
marmot logout --profile staging
```

## Commands

| Command                                                                                  | What it does                                                                            |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `status [--fail-on-down]`                                                                | Counts by status and the monitors that are down, degraded or pending.                   |
| `monitors list [--type T] [--active \| --paused]`                                        | All monitors with key, type, status and target.                                         |
| `monitors info KEY\|ID`                                                                  | One monitor: target, interval, last check, message, ping.                               |
| `monitors logs KEY\|ID [--limit N] [--important]`                                        | Latest heartbeats, newest first (`--important`: status changes only).                   |
| `monitors check KEY\|ID [--no-wait] [--timing]`                                          | Run the monitor's check now and print the result (`--timing`: request phases, details). |
| `monitors pause KEY\|ID`, `monitors resume KEY\|ID`                                      | Pause or resume a monitor.                                                              |
| `monitors import [-o FILE] [--format yaml\|json] [--redact-secrets]`                     | Write the organization's monitors as a monitors file (alias `monitors export`).         |
| `monitors plan -f FILE [--prune] [--exit-code]`                                          | Show what `apply` would change. Changes nothing.                                        |
| `monitors apply -f FILE [--prune] [--dry-run] [-y]`                                      | Create, update (and with `--prune` delete) monitors to match the file.                  |
| `monitors schema [-o FILE]`                                                              | JSON Schema of the file format, for editor autocomplete.                                |
| `check URL\|HOST [--type T] [--keyword K] [--method M] [--timeout S] [--timing]`         | One-off check of an unsaved configuration; nothing is stored.                           |
| `status-pages list`, `status-pages info SLUG\|ID`                                        | Status pages and their component groups.                                                |
| `incidents list --page SLUG\|ID [--all]`                                                 | Open (with `--all`: every) incident of a page.                                          |
| `incidents create --page P --title T [--status S] [--message M] [--impact I] [--pinned]` | Open an incident; the first update is `investigating` unless `--status` says otherwise. |
| `incidents update ID --page P [--status S] [--message M] [--resolve] [--title T]`        | Post an update (`--resolve` posts `resolved`) or change the title, impact or pin.       |
| `maintenance list`                                                                       | Maintenance with its current status.                                                    |
| `maintenance create --title T --start DT --end DT [--monitor KEY\|ID]…`                  | Schedule a single window; `-f FILE` takes any maintenance body (YAML or JSON) instead.  |
| `import -f FILE [--dry-run]`                                                             | Import a Marmot export or an Uptime Kuma backup through the server's importer.          |
| `login`, `logout`, `config`                                                              | Manage the saved connection (see above).                                                |

Monitors are referenced by their monitors-as-code key or by their id (`12` or `#12`; a key wins when both
match). Status pages by slug or id. `-f -` reads a file from standard input.

Global flags: `--json` (machine-readable output on stdout, also for errors), `--quiet` / `-q` (no progress
or hints), `--no-color`, `--url`, `--api-key`, `--org`, `--profile`, `--help` / `-h` (also
`marmot help monitors apply`), `--version` / `-V`.

`monitors check` and `check URL` use the on-demand check endpoints (`POST …/monitors/:id/check`,
`POST …/checks`); instances without them answer `404`, which the CLI explains.

### Exit codes

| Code | Meaning                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------- |
| `0`  | Success (for `plan --exit-code`: no changes).                                                  |
| `1`  | The API refused a request, the instance could not be reached, or `apply` failed part-way.      |
| `2`  | Invalid command line or invalid file (syntax, unknown fields, schema errors, unknown channel). |
| `3`  | `plan --exit-code` / `apply --dry-run --exit-code`: there are changes to apply.                |
| `4`  | `status --fail-on-down` found a monitor down; `check` / `monitors check` result is down.       |

## Monitors as code

### The file

```yaml
# yaml-language-server: $schema=./marmot.schema.json
version: 1
monitors:
  - key: backend # stable identifier, unique per organization
    name: Backend
    type: group

  - key: api
    name: API
    type: http
    url: https://api.example.com/health
    interval: 30
    parent: backend # key of a group monitor
    notifications: [Ops Slack, PagerDuty] # channel names
    tags: [prod, { tag: region, value: eu }]
    authMethod: bearer
    bearerToken: ${API_HEALTH_TOKEN} # from the environment

  - key: db
    name: Primary database
    type: postgres
    databaseConnectionString: ${DB_URL}
    active: false # paused
```

- **`key`** maps the entry to a monitor. It is stored on the monitor (the _Monitors-as-code key_ in the
  admin sidebar) and unique per organization. Letters, digits, `.`, `-` and `_`, starting and ending with a
  letter or digit. Renaming a monitor keeps its key; changing the key means "a different monitor".
- Every other field is a field of the monitor form, with the names of the API
  ([Monitor types](Monitor-Types.md), or `marmot monitors schema`). Entries are validated with the same zod
  schema the API uses, so the messages are the ones the UI shows. Fields you leave out take the form's
  default for the type: the file describes the whole monitor.
- **`parent`** is the key of a group monitor, **`notifications`** are channel names and **`tags`** tag
  names (with an optional value). Missing tags are created; unknown channels are an error (channels hold
  credentials and are managed in the UI or the API).
- **`notifications`** and **`active`** are only managed when the entry sets them. Leave `notifications`
  out to keep the channels attached in Marmot (new monitors then get the organization's default channels);
  `notifications: []` detaches all. Leave `active` out so pausing a monitor during an incident does not get
  undone by the next deploy.
- Strings may reference environment variables: `${NAME}`, or `${NAME:-default}`; `$${` writes a literal
  `${`. An unset variable without a default is an error. Plans never print credential fields (passwords,
  tokens, private keys, connection strings, headers, …), only that they change.
- `proxy` and `dockerHost` take the id of the organization's proxy or Docker host.
- A Marmot export (`format: marmot`, see [Import and export](Import-and-Export.md)) is accepted as a file
  too: its ids become keys and channel ids channel names. Tags, proxies and Docker hosts of an export are
  ids of the exporting instance and are dropped with a warning.

### Plan and apply

```
$ marmot monitors plan -f marmot.yaml
  + create tag region
  + create  api  "API" (http)
      parent: "backend"
      notifications: ["Ops Slack","PagerDuty"]
      url: "https://api.example.com/health"
      interval: 30
      bearerToken: (sensitive value)
  ~ update  website  "Website" (http) #12
      interval: 60 → 120
  ~ update  legacy  "Legacy" (http) #7  (adopts an existing monitor without a key)
      key: null → "legacy"
  - delete  old-check  "Old check" (http) #9

Plan: 1 to create, 2 to update, 1 to delete, 6 unchanged.
```

1. Each entry is matched to the monitor with the same key.
2. An entry whose key is not in use **adopts** the one monitor without a key that has the same name and
   type: the key is recorded on it (shown as `key: null → "…"`) and nothing is created. With several
   candidates the CLI warns and creates a new monitor.
3. Otherwise the entry is created. Groups are created before their children.
4. Updates send only the fields that differ.
5. Monitors that have a key but are not in the file are listed as a warning, and deleted with
   `--prune`. **Monitors without a key are never deleted**: the key is the ownership marker, so monitors
   made in the UI are safe from `--prune`.

`apply` prints the plan and asks for confirmation; `-y` skips the question and is required when stdin is
not a terminal (CI). `apply --dry-run` is `plan`. `apply` is idempotent: running it twice changes nothing
the second time. It stops at the first refused change and reports what it had done; fix the problem and
run it again.

A `read` key can plan (useful in pull requests), but cannot list notification channels: the plan then
warns and leaves channel changes out. Apply with a `write` key.

### Start from what you have

```sh
marmot monitors import -o marmot.yaml                      # credentials written as they are stored
marmot monitors import --redact-secrets -o marmot.yaml     # credentials as ${MARMOT_<KEY>_<FIELD>}
marmot monitors schema -o marmot.schema.json               # editor autocomplete
```

`import` writes every monitor with only the fields that differ from the defaults of its type. Monitors
without a key get one derived from their name; the first `apply` of the file records those keys (it shows
up as adoptions and changes nothing else). After that, `import` followed by `apply` is a no-op.
`--redact-secrets` replaces credentials with environment references and lists the variable names, so the
file can be committed.

### GitOps example

On GitHub, the [GitHub Action](GitHub-Action.md) does this in one step (`mode: apply`, a dry run on pull
requests with the diff in the job summary). With the CLI itself, keep `marmot.yaml` in the repository,
plan on pull requests with a read key and apply on the main branch with a write key:

```yaml
# .github/workflows/monitors.yml
name: monitors
on:
  pull_request:
    paths: [marmot.yaml]
  push:
    branches: [main]
    paths: [marmot.yaml]

jobs:
  monitors:
    runs-on: ubuntu-latest
    env:
      MARMOT_URL: https://status.example.com
      MARMOT_ORG: '1'
      API_HEALTH_TOKEN: ${{ secrets.API_HEALTH_TOKEN }}
      DB_URL: ${{ secrets.DB_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Fetch the CLI
        run: docker run --rm --entrypoint cat ghcr.io/thinkhumandotdev/marmot:latest /app/dist/cli/marmot.mjs > marmot.mjs
      - name: Plan
        if: github.event_name == 'pull_request'
        env:
          MARMOT_API_KEY: ${{ secrets.MARMOT_READ_KEY }}
        run: node marmot.mjs monitors plan -f marmot.yaml
      - name: Apply
        if: github.event_name == 'push'
        env:
          MARMOT_API_KEY: ${{ secrets.MARMOT_WRITE_KEY }}
        run: node marmot.mjs monitors apply -f marmot.yaml --prune -y
```

Use one file per environment (`marmot.staging.yaml`, `marmot.production.yaml`) or one file with
`${…}` references and a job per environment with its own `MARMOT_URL`, `MARMOT_ORG` and key.

## Server side

The CLI added three things to the management API, documented in `/api/openapi.json`:

- the monitor field `key` (monitors-as-code key, unique per organization, `null` when unmanaged) and the
  list filter `GET /api/orgs/:orgId/monitors?key=…`; clones get no key, and imports drop keys already in
  use with a warning;
- `GET /api/orgs/:orgId/monitors/:id/heartbeats[?limit=&important=true]` for `monitors logs`;
- `GET`/`POST /api/orgs/:orgId/tags` for resolving and creating tags by name.

## Code layout

| Path                     | Contents                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `src/cli/core/client.ts` | HTTP client of the management API (only needs `fetch`).                                                |
| `src/cli/core/spec.ts`   | File format: parsing, `${ENV}` interpolation, Marmot export conversion, JSON Schema.                   |
| `src/cli/core/plan.ts`   | Matching, validation and the field diff (pure).                                                        |
| `src/cli/core/apply.ts`  | Carrying out a plan through the client.                                                                |
| `src/cli/core/export.ts` | Server state → file.                                                                                   |
| `src/cli/run.ts`         | Argument parsing and dispatch; `src/cli/commands/*` the commands, `src/cli/marmot.ts` the entry point. |

`src/cli/core` has no Node-specific dependencies besides `fetch`, so the [GitHub Action](GitHub-Action.md)
(`src/action/`) reuses `planMonitors` / `applyPlan` directly. The CLI's messages are in the `cli` namespace
of `src/i18n/messages/en.json`.
