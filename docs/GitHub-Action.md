# GitHub Action

Marmot ships a GitHub Action that runs from your workflows against your Marmot instance:

- **`run`**: runs the checks of the monitors you list now ("Check now"), waits for the results, writes a
  table to the job summary and **fails the job** when a monitor is down or an assertion fails. Use it after
  a deploy to make CI fail when the new version does not pass the checks Marmot runs in production.
- **`apply`**: applies a [monitors-as-code](CLI.md#monitors-as-code) file, like
  `marmot monitors apply -f marmot.yaml -y`. On pull requests it only plans and shows the diff in the job
  summary.

```yaml
- uses: thinkhumandotdev/marmot/action@v0.5.0
  with:
    url: https://status.example.com
    api-key: ${{ secrets.MARMOT_API_KEY }}
    org: '1'
    monitors: api, website
```

The action lives in the [`action/`](../action/action.yml) folder of the Marmot repository and reuses the
[CLI](CLI.md)'s code (the API client, plan and apply). It runs on the runner's Node.js; nothing is built or
installed in your job, and it talks to Marmot only through the
[management API](Integrations.md#management-api).

## Setup

1. Create an organization API key under **Settings → API keys** and store it as a repository or environment
   secret (`MARMOT_API_KEY` below). `run` and `apply` need a **write** key: checks and changes are writes.
   A **read** key is enough for plans (`mode: apply` with a dry run); a read key cannot list notification
   channels, so its plans leave channel changes out (see [Plan and apply](CLI.md#plan-and-apply)).
2. Note the organization id (shown on the API keys page) and the URL of your instance. The runner must be
   able to reach the instance; for an instance on a private network use a self-hosted runner.

The connection inputs fall back to the environment variables the CLI reads (`MARMOT_URL`,
`MARMOT_API_KEY`, `MARMOT_ORG`), so a job-level `env:` block can set them once for several steps.

## Inputs

| Input              | Default           | Description                                                                                                                                                                         |
| ------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`              | `$MARMOT_URL`     | Base URL of the instance, e.g. `https://status.example.com`.                                                                                                                        |
| `api-key`          | `$MARMOT_API_KEY` | Organization API key (`mk_…`). Pass it from a secret.                                                                                                                               |
| `org`              | `$MARMOT_ORG`     | Organization id.                                                                                                                                                                    |
| `mode`             | `run`             | `run` (check now) or `apply` (monitors as code).                                                                                                                                    |
| `monitors`         |                   | `run`: monitor keys or ids (`12` or `#12`; a key wins when both match), separated by newlines, commas or spaces.                                                                    |
| `config`           |                   | Monitors file (YAML or JSON). `apply`: the file to apply. `run`: when `monitors` is empty, every monitor of the file is checked, except paused (`active: false`) and push monitors. |
| `fail-on-degraded` | `false`           | `run`: also fail when a check is degraded (slower than the monitor's threshold).                                                                                                    |
| `dry-run`          | `auto`            | `apply`: `true` only plans, `false` applies. `auto` plans on `pull_request`, `pull_request_target` and `merge_group` events and applies on every other event (push, schedule, …).   |
| `prune`            | `false`           | `apply`: delete monitors that have a key but are no longer in the file (as `--prune`; monitors without a key are never deleted).                                                    |

## Outputs

| Output    | Mode    | Description                                                                                                                  |
| --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `result`  | `run`   | `passed` or `failed`.                                                                                                        |
| `passed`  | `run`   | Number of passing checks.                                                                                                    |
| `failed`  | `run`   | Number of failing checks.                                                                                                    |
| `skipped` | `run`   | Number of skipped checks (monitors in maintenance).                                                                          |
| `json`    | `run`   | The results as a JSON array: `ref`, `id`, `key`, `name`, `status`, `ping`, `statusCode`, `message`, `assertions`, `verdict`. |
| `changes` | `apply` | Number of changes in the plan (monitors to create, update or delete and tags to create).                                     |
| `plan`    | `apply` | The plan as text, in the diff format of the job summary (e.g. for a pull request comment).                                   |
| `dry-run` | `apply` | `true` when the step only planned.                                                                                           |

## Run checks after a deploy

The action calls `POST /api/orgs/:orgId/monitors/:id/check` for each monitor and waits for the result
(up to the monitor's timeout). The result is stored as a manual heartbeat, like **Check now** in the UI:
a failing check after a deploy shows up in the monitor's history and notifies as usual.

| Check result                                                  | Verdict                                               |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| `up`                                                          | passed                                                |
| `degraded`                                                    | passed with a warning; failed with `fail-on-degraded` |
| `down`, or any failed [assertion](Monitors.md)                | **failed**                                            |
| `pending` (the check failed, the monitor has retries left)    | **failed**                                            |
| in a maintenance window                                       | skipped                                               |
| unknown key or id, paused or push monitor, timeout, API error | **failed** (shown as `error`)                         |

The job fails (exit code 1) when at least one check failed. Each failure is also an error annotation on
the run. Checks run three at a time. Instances limit on-demand checks per organization
(`ON_DEMAND_CHECKS_PER_MINUTE`, 30 per minute by default); when the limit is hit the action waits and
retries.

```yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./deploy.sh # your deployment

      - name: Run Marmot's checks against the new version
        uses: thinkhumandotdev/marmot/action@v0.5.0
        with:
          url: https://status.example.com
          api-key: ${{ secrets.MARMOT_API_KEY }}
          org: '1'
          monitors: |
            api
            website
            checkout
          fail-on-degraded: 'true'
```

If the deployment needs a moment before it serves traffic, wait for it first (for example with a
`curl --retry` loop): the action checks once and does not retry a failing check. To check every monitor of
your monitors file instead of a list, pass `config: marmot.yaml` and leave `monitors` out.

The job summary looks like this:

> **2 passed, 1 failed, 0 skipped** · https://status.example.com
>
> | Result    | Monitor             | Status | Response          | Message                                       |
> | --------- | ------------------- | ------ | ----------------- | --------------------------------------------- |
> | ✅ passed | API `api`           | up     | 87 ms · HTTP 200  | 200 - OK                                      |
> | ✅ passed | Website `website`   | up     | 140 ms · HTTP 200 | 200 - OK                                      |
> | ❌ failed | Checkout `checkout` | down   | 230 ms · HTTP 502 | Assertion failed: status equals 200 (got 502) |

## Monitors as code in pull requests

Plan on pull requests (the diff goes to the job summary and nothing changes), apply on the main branch.
With `dry-run: auto` (the default) one step does both:

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
    # Applies on main only; one apply at a time.
    concurrency: marmot-monitors
    steps:
      - uses: actions/checkout@v4
      - uses: thinkhumandotdev/marmot/action@v0.5.0
        env:
          # ${VARIABLES} referenced in marmot.yaml
          API_HEALTH_TOKEN: ${{ secrets.API_HEALTH_TOKEN }}
        with:
          mode: apply
          config: marmot.yaml
          url: https://status.example.com
          org: '1'
          api-key: ${{ secrets.MARMOT_API_KEY }}
          prune: 'true'
```

The summary shows the plan as a diff (`+` create, `!` update, `-` delete), the warnings (monitors with a key
that are not in the file, ambiguous adoptions) and whether it was applied. Credential fields (passwords,
tokens, connection strings, headers) only show that they change, never their values; still, the job
summary is visible to everyone who can read the repository's Actions runs.

To use a read key for plans and a write key for applying, pass
`api-key: ${{ github.event_name == 'push' && secrets.MARMOT_WRITE_KEY || secrets.MARMOT_READ_KEY }}`.
Pull requests from forks get no secrets: plans only run for branches of the repository itself.

To also post the plan on the pull request, use the `plan` output, for example with the GitHub CLI
(the job then needs `permissions: pull-requests: write`):

````yaml
- uses: thinkhumandotdev/marmot/action@v0.5.0
  id: marmot
  with:
    mode: apply
    config: marmot.yaml
    url: https://status.example.com
    org: '1'
    api-key: ${{ secrets.MARMOT_READ_KEY }}
- if: github.event_name == 'pull_request' && steps.marmot.outputs.changes != '0'
  env:
    GH_TOKEN: ${{ github.token }}
    PLAN: ${{ steps.marmot.outputs.plan }}
  run: printf '### Marmot plan\n\n```diff\n%s\n```\n' "$PLAN" | gh pr comment ${{ github.event.number }} --body-file -
````

An invalid file (syntax, unknown fields, unknown channel names, unset `${VARIABLES}`) fails the step with
the problems listed in the summary. A change the API refuses stops the apply there; what was applied
before stays, and the next run picks up from the current state (see [Plan and apply](CLI.md#plan-and-apply)).

## Versions

The action is versioned with Marmot: the release tag `vX.Y.Z` of the repository is the action's version, and
`thinkhumandotdev/marmot/action@vX.Y.Z` runs the action of that release. Use the version of your instance
(or a newer one), and pin a tag or a commit SHA. While Marmot is `0.x` there is no moving `v0` tag, and
`@main` follows development. The code is in `src/action/` and bundled into `action/dist/index.mjs`
(`pnpm build:action`, see [Development](Development.md#server-bundles)).

## Other CI systems

Elsewhere, use the CLI directly: `marmot monitors check KEY` exits with code `4` when the result is
down, `marmot monitors plan -f FILE` / `marmot monitors apply -f FILE -y` work as in the action (see the
[exit codes](CLI.md#exit-codes)). The CLI is one file, `/app/dist/cli/marmot.mjs` in the Marmot image, and
needs Node.js 20 or later.

GitLab CI, using the Marmot image as the job image:

```yaml
# .gitlab-ci.yml
.marmot:
  image:
    name: ghcr.io/thinkhumandotdev/marmot:0.5.0
    entrypoint: ['']
  variables:
    MARMOT_URL: https://status.example.com
    MARMOT_ORG: '1'
    # MARMOT_API_KEY: a masked CI/CD variable

post-deploy-checks:
  extends: .marmot
  stage: .post
  script:
    - for key in api website checkout; do node /app/dist/cli/marmot.mjs monitors check "$key" || exit 1; done

monitors-plan:
  extends: .marmot
  rules:
    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'
  script:
    - node /app/dist/cli/marmot.mjs monitors plan -f marmot.yaml

monitors-apply:
  extends: .marmot
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - node /app/dist/cli/marmot.mjs monitors apply -f marmot.yaml -y
```

CircleCI, copying the CLI out of the image:

```yaml
# .circleci/config.yml
version: 2.1
jobs:
  marmot:
    docker:
      - image: cimg/node:lts
    environment:
      MARMOT_URL: https://status.example.com
      MARMOT_ORG: '1'
      # MARMOT_API_KEY: in a context or the project's environment variables
    steps:
      - checkout
      - setup_remote_docker
      - run: docker run --rm --entrypoint cat ghcr.io/thinkhumandotdev/marmot:0.5.0 /app/dist/cli/marmot.mjs > marmot.mjs
      - run: node marmot.mjs monitors apply -f marmot.yaml -y
      - run: for key in api website checkout; do node marmot.mjs monitors check "$key" || exit 1; done
workflows:
  deploy:
    jobs:
      - marmot:
          filters:
            branches:
              only: main
```

`monitors check` also prints the result; add `--json` for machine-readable output.
