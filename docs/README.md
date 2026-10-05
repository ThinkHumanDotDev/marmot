# Marmot documentation

Marmot is a self-hosted status monitor for teams: Uptime Kuma's monitoring and alerting, kan.bn-style
organizations, built on Payload CMS 3 and Next.js. These pages are written for the people who run it, the
people who use it and the people who change it. Pages marked _(landing in the current release)_ describe
features whose pull requests are merging alongside this documentation.

## Run it

| Page                                  | What it covers                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [Getting started](getting-started.md) | Docker compose quick start, the first-run setup wizard, your first monitor and your first status page.                        |
| [Configuration](configuration.md)     | Every environment variable (grouped, with defaults and the process that reads it), instance settings, first-run and realtime. |
| [Deployment](deployment.md)           | Caddy auto-TLS, running behind nginx/Traefik, MongoDB, scaling workers, backups and restore, upgrades, single-container mode. |
| [Single sign-on](sso.md)              | Generic OIDC with Keycloak, Authentik and Microsoft Entra ID examples, auto-provisioning and logout.                          |
| [Telemetry](telemetry.md)             | What the opt-in analytics collect and how consent works _(landing in the current release)_.                                   |
| [Billing](billing.md)                 | The plan/entitlement scaffold for hosted offerings; off on self-hosted installs _(landing in the current release)_.           |

## Use it

| Page                                                      | What it covers                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [Monitors](monitors.md)                                   | Monitor concepts: types, intervals and retries, groups, push monitors, pausing and cloning.                        |
| [Monitor types](monitor-types.md)                         | Field-by-field reference for every monitor type _(landing in the current release)_.                                |
| [Notifications](notifications.md)                         | Notification channels, the delivery pipeline, message templates and the provider reference.                        |
| [Status pages](status-pages.md)                           | Public status pages, incidents, custom domains and the public JSON/RSS endpoints.                                  |
| [Maintenance](maintenance.md)                             | Maintenance windows and how they silence alerts _(landing in the current release)_.                                |
| [Organizations and members](organizations-and-members.md) | Roles and permissions, invitations, invite links, ownership transfer, account settings.                            |
| [Integrations](integrations.md)                           | Status badges, the push endpoint, Prometheus metrics and organization API keys _(landing in the current release)_. |

## Change it

| Page                                      | What it covers                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)           | Processes, polling engine, time-series storage, notifications pipeline, realtime, RBAC.     |
| [Development](development.md)             | Local setup with or without Docker, the three processes, tests, migrations, server bundles. |
| [Release checklist](release-checklist.md) | What to verify before tagging a version.                                                    |
| [Comparison](comparison.md)               | Feature-by-feature parity with Uptime Kuma and the kan.bn-inspired team features.           |
| [Contributing](../CONTRIBUTING.md)        | Workflow, commit conventions, how to add a monitor type or a notification provider.         |
| [Security policy](../SECURITY.md)         | How to report a vulnerability.                                                              |

Found a mistake? Documentation lives next to the code; open a pull request with the `docs(docs): …` prefix.
