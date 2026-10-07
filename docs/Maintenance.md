# Maintenance windows

A maintenance window tells Marmot that a set of monitors is _expected_ to be offline for a while: during the
window their checks are replaced by `maintenance` heartbeats, no notification is sent, and the status pages
you attach show a maintenance banner instead of an outage. This is how you deploy, patch or migrate without
paging the on-call and without a red bar on your public status page.

## Concepts

| Term     | Meaning                                                                                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window   | A `maintenance` document: title, description (Markdown), the monitors it covers, the status pages that announce it, and a schedule.                                                                                                                                                             |
| Strategy | How the window repeats: **manual** (active until you pause it), **single** (one start/end), **recurring interval** (every N days), **recurring weekday** (e.g. every Tuesday 02:00–03:00), **recurring day of month** (`1`–`31` or the last days), **cron** (pattern plus duration in minutes). |
| Status   | `scheduled` (before the next start), `under-maintenance` (active now), `ended` (past its last occurrence), `inactive` (paused by you), `unknown` (the schedule cannot be evaluated).                                                                                                            |
| Timezone | Schedules are evaluated in the window's IANA timezone, DST-aware. The default, _same as server_ (`SAME_AS_SERVER`), uses the organization's `settings.timezone`.                                                                                                                                |

Maintenance is **org-scoped**: by default viewers can see windows (`maintenance:read`), members and above
create, edit, pause and delete them (`maintenance:create|update|delete`); owners can change these minimums
under **Settings → Permissions** ([Organizations and members](Organizations-and-Members.md)). Monitors and
status pages must belong to the same organization as the window.

## Effect on monitors and alerts

The worker asks the maintenance resolver before every check (`setMaintenanceResolver` in
`src/server/engine/hooks.ts`, installed by `createMaintenanceResolver()` from `src/server/maintenance`). A
monitor is under maintenance when an active window listing it is running, or when one of its parent groups is
(recursively). In that case the check is skipped and a `maintenance` beat is recorded instead: it counts as
**up** in the uptime statistics (Uptime Kuma semantics) and never notifies. When the window ends the next
check decides the real state; a monitor that is still broken then goes DOWN and alerts as usual.

Monitors currently in maintenance show a blue status in the dashboard, the monitor list and the badges.

## Effect on status pages

Attaching a status page to a window makes the page announce it; it does not put the page's monitors into
maintenance (list them under **Monitors** for that). Public pages render running windows and windows that
start within the next seven days in a **maintenance** block above the monitor groups, with the title,
description and the time range in the visitor's local time. The public JSON
(`GET /api/status-pages/:slug/public`) exposes them in its `maintenance` array, running windows first
([Status pages](Status-Pages.md)). The page's overall status becomes `maintenance` when its monitors report
maintenance and nothing else is down.

## Managing windows

`/{org}/maintenance` lists the organization's windows with their schedule, status and the current or next
occurrence. With no windows yet, the empty state offers **Schedule maintenance** to members who may create
one; the same action is in the page header and in the command palette (⌘K / Ctrl+K). The form covers title,
description, strategy, date and time range, interval/weekdays/days of month or cron and duration, timezone,
and pickers for the affected monitors and status pages. A window can be paused (`inactive`) and resumed,
edited while it runs, or deleted, after which affected monitors resume normal checks on their next run.

Times in the list are shown in the zone each window is evaluated in (with the zone name), and the cron
preview in the form lists the next matches in the window's timezone (the organization's for _same as
server_), so what you read is what the worker will do.

Route handlers follow the usual pattern (zod schema shared with the form in
`src/lib/validation/maintenance.ts`):

| Method                   | Path                                                     |
| ------------------------ | -------------------------------------------------------- |
| `GET`, `POST`            | `/api/orgs/:orgId/maintenance`                           |
| `GET`, `PATCH`, `DELETE` | `/api/orgs/:orgId/maintenance/:id`                       |
| `POST`                   | `/api/orgs/:orgId/maintenance/:id/pause`, `…/:id/resume` |

## How status is kept current

Status is a pure function of the document and the clock (`src/server/maintenance/status.ts`); there is no
in-memory timer per window. The collection hooks compute `status` on save, and the `maintenance-status` job
on the worker's `marmot:maintenance` queue recomputes every window each minute, persists changes and publishes
the `maintenanceList` realtime event so open maintenance pages update live. See
[Architecture](Architecture.md#maintenance-windows) for the details.

## Related

- [Monitors](Monitors.md) for the heartbeat state machine.
- [Notifications](Notifications.md) for what does and does not notify.
- [Comparison](Comparison.md) for the Uptime Kuma parity status.
