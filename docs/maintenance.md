# Maintenance windows

> **Status:** landing in the current release. The `/{org}/maintenance` page on `main` is a placeholder; the
> behaviour below describes the feature as it is being merged and may still change in details.

A maintenance window tells Marmot that a set of monitors is _expected_ to misbehave for a while: during the
window their checks keep running, but a failed check produces a `maintenance` heartbeat instead of `down`,
no notification is sent, and the affected status pages show a maintenance banner instead of an outage. This
is how you deploy, patch or migrate without paging the on-call and without a red bar on your public status
page.

## Concepts

| Term     | Meaning                                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window   | A `maintenance` document: title, description, the monitors (or whole status pages) it covers, and a schedule.                                                                                                                   |
| Strategy | How the window repeats: **manual** (active until you stop it), **single** (one start/end), **recurring interval** (every N days), **recurring weekday** (e.g. every Tuesday 02:00–03:00), **recurring day of month**, **cron**. |
| Status   | `scheduled` (before the next start), `under-maintenance` (active now), `ended` (past its last occurrence), `inactive` (paused by you).                                                                                          |
| Timezone | Recurring schedules are evaluated in the window's timezone (defaults to the organization's `settings.timezone`).                                                                                                                |

Maintenance is **org-scoped**: viewers can see windows (`maintenance:read`), members and above create, edit
and end them (`maintenance:create|update|delete`). Attaching a status page to a window covers every monitor
shown on that page, which is the usual choice for a planned outage.

## Effect on monitors and alerts

The worker asks the maintenance resolver before every check (`setMaintenanceResolver` in
`src/server/engine/hooks.ts`). When the monitor is covered by an active window the beat is recorded as
`maintenance`, counts as **up** in the uptime statistics (Uptime Kuma semantics) and never notifies. When the
window ends the next check decides the real state; a monitor that is still broken then goes DOWN and alerts
as usual.

Monitors currently in maintenance show a blue status in the dashboard, the monitor list and the badges.

## Effect on status pages

Public pages render active and upcoming windows in a **maintenance** block above the monitor groups, with the
title, description and the time range in the visitor's local time. The page's overall status becomes
`maintenance` while a window covers any of its monitors and nothing else is down. The public JSON
(`GET /api/status-pages/:slug/public`) exposes the windows in its `maintenance` array, which is already part
of the payload shape today ([status-pages.md](status-pages.md)).

## Managing windows

`/{org}/maintenance` lists windows grouped by status with their next occurrence; **Schedule maintenance**
opens the form (title, description, affected monitors and status pages, strategy, date range, timezone).
A window can be paused (`inactive`) and resumed, edited while running, or ended early. Route handlers follow
the usual pattern: `GET/POST /api/orgs/:orgId/maintenance`, `PATCH/DELETE /api/orgs/:orgId/maintenance/:id`,
`POST …/:id/{pause,resume}`.

The live `maintenanceList` realtime event keeps dashboards in sync when a window starts or ends.

## Related

- [monitors.md](monitors.md) for the heartbeat state machine.
- [notifications.md](notifications.md) for what does and does not notify.
- [comparison.md](comparison.md) for the Uptime Kuma parity status.
