# Marmot documentation

Marmot is a self-hosted status monitor for teams: Uptime Kuma's monitoring and alerting, kan.bn-style
organizations, built on Payload CMS 3 and Next.js. These pages are written for the people who run it, the
people who use it and the people who change it. Pages marked describe
features whose pull requests are merging alongside this documentation.

## Run it

| Page                                  | What it covers                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [Getting started](Getting-Started.md) | Docker compose quick start, the first-run setup wizard, your first monitor and your first status page.                        |
| [Configuration](Configuration.md)     | Every environment variable (grouped, with defaults and the process that reads it), instance settings, first-run and realtime. |
| [Deployment](Deployment.md)           | Caddy auto-TLS, running behind nginx/Traefik, MongoDB, scaling workers, backups and restore, upgrades, single-container mode. |
| [Single sign-on](Single-Sign-On.md)   | Generic OIDC, GitHub and Google sign-in, per-organization OIDC/SAML connections with verified domains, linked accounts.       |
| [Security](Security.md)               | Hardening checklist: TLS, trusted proxies, rate limiting, security headers, audit log and admin access.                       |
| [Telemetry](Telemetry.md)             | What the opt-in analytics collect and how consent works.                                                                      |
| [Billing](Billing.md)                 | The plan/entitlement scaffold for hosted offerings; off on self-hosted installs.                                              |

## Use it

| Page                                                      | What it covers                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Monitors](Monitors.md)                                   | Monitor concepts: types, intervals and retries, groups, push monitors, pausing and cloning. |
| [Monitor types](Monitor-Types.md)                         | Field-by-field reference for every monitor type.                                            |
| [Notifications](Notifications.md)                         | Notification channels, the delivery pipeline, message templates and the provider reference. |
| [Status pages](Status-Pages.md)                           | Public status pages, incidents, custom domains and the public JSON/RSS endpoints.           |
| [Maintenance](Maintenance.md)                             | Maintenance windows and how they silence alerts.                                            |
| [Organizations and members](Organizations-and-Members.md) | Roles and permissions, invitations, invite links, ownership transfer, account settings.     |
| [Integrations](Integrations.md)                           | Status badges, the push endpoint, Prometheus metrics and organization API keys.             |
| [Import and export](Import-and-Export.md)                 | Importing an Uptime Kuma backup or a Marmot export, and exporting an organization.          |

## Change it

| Page                                       | What it covers                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [Architecture](Architecture.md)            | Processes, polling engine, time-series storage, notifications pipeline, realtime, RBAC.     |
| [Development](Development.md)              | Local setup with or without Docker, the three processes, tests, migrations, server bundles. |
| [Release checklist](Release-Checklist.md)  | What to verify before tagging a version.                                                    |
| [Comparison](Comparison.md)                | Feature-by-feature parity with Uptime Kuma and the kan.bn-inspired team features.           |
| [Contributing](../.github/CONTRIBUTING.md) | Workflow, commit conventions, how to add a monitor type or a notification provider.         |
| [Security policy](../.github/SECURITY.md)  | How to report a vulnerability.                                                              |

Found a mistake? Documentation lives next to the code in `docs/` and is published to the GitHub wiki on every
push to `main`; open a pull request with the `docs(docs): …` prefix.
