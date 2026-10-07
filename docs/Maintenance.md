# Maintenance windows

A maintenance window tells Marmot that a set of monitors is _expected_ to be offline for a while: during the
window their checks are replaced by `maintenance` heartbeats, no notification is sent, and the status pages
you attach show a maintenance banner instead of an outage. This is how you deploy, patch or migrate without
paging the on-call and without a red bar on your public status page.

## Concepts

| Term       | Meaning                                                                                                                                                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window     | A `maintenance` document: title, description (Markdown), the monitors it covers, the status pages that announce it, and a schedule.                                                                                                                                                             |
| Strategy   | How the window repeats: **manual** (active until you pause it), **single** (one start/end), **recurring interval** (every N days), **recurring weekday** (e.g. every Tuesday 02:00–03:00), **recurring day of month** (`1`–`31` or the last days), **cron** (pattern plus duration in minutes). |
| Status     | `scheduled` (before the next start), `under-maintenance` (an occurrence is in progress or verifying), `ended` (past its last occurrence), `inactive` (paused by you), `unknown` (the schedule cannot be evaluated). It follows the occurrences, not just the clock (see below).                 |
| Occurrence | One concrete window of a maintenance (the single window, each recurring or cron run, or the run of a manual maintenance) with its own state and update timeline.                                                                                                                                |
| Timezone   | Schedules are evaluated in the window's IANA timezone, DST-aware. The default, _same as server_ (`SAME_AS_SERVER`), uses the organization's `settings.timezone`.                                                                                                                                |

Maintenance is **org-scoped**: by default viewers can see windows (`maintenance:read`), members and above
create, edit, pause and delete them (`maintenance:create|update|delete`); owners can change these minimums
under **Settings → Permissions** ([Organizations and members](Organizations-and-Members.md)). Monitors and
status pages must belong to the same organization as the window.

## Announcements: occurrences, updates and reminders

Every concrete window is a `maintenance-occurrences` document with a lifecycle and a public timeline, so a
recurring maintenance tracks state and updates **per occurrence**:

```
scheduled ──start──▶ in-progress ◀──▶ verifying
    │                     │               │
    └──cancel──▶ cancelled └──complete──▶ completed ◀┘
```

- **Automatic start and completion.** `autoStart` and `autoComplete` (both on by default) move an occurrence
  to `in-progress` at its planned start and to `completed` at its planned end. With `autoStart` off a due
  window stays `scheduled` (monitors keep alerting) until someone starts it; if nobody does, it is dropped
  when a later occurrence becomes due. With `autoComplete` off a window that runs over stays `in-progress`
  and keeps suppressing alerts until someone completes it. Starting an occurrence completes an older one that
  is still open.
- **Manual control and updates.** The edit page lists the upcoming, running and recent windows. **Start
  now**, **Mark as verifying**, **Back in progress**, **Complete** and **Cancel window** change the state; the
  composer posts a note (Markdown) without changing it. Each change appends an update `{ status, message,
postedAt }` (the same shape as incident updates) that the status page shows. Only upcoming windows can be
  cancelled; finished ones still accept notes. Completing the run of a manual maintenance pauses it.
- **Reminders.** `reminders` lists offsets before the start (15 min to 1 week; default 24 h and 1 h). Each
  offset is handled once per occurrence and recorded in `remindersSent`; a reminder more than 30 minutes late
  (worker down, offset added afterwards) is recorded as skipped instead of sent.
- **Schedule edits.** An upcoming occurrence moves with the schedule (keeping its updates); one whose window
  disappeared is deleted, or cancelled when it already had updates. Pausing completes the running occurrence
  and drops upcoming ones without updates.
- **Notifications.** Subscriber delivery is [#104](https://github.com/thinkhumandotdev/marmot/issues/104).
  The hook point exists: `registerMaintenanceEventListener()` in `src/server/maintenance/events.ts` receives
  `scheduled`, `reminder`, `started`, `updated`, `completed` and `cancelled` events (maintenance, occurrence
  with its timeline, the update or reminder offset) after the change is committed, in the process that made
  it (worker for automatic changes and reminders, web for admin actions). Today they are only logged.

Transitions and reminders run from **delayed BullMQ jobs** (`maintenance-wakeup` on `marmot:maintenance`,
one per planned start, end and reminder instant, job id `maintenance-wakeup-<id>-<epoch ms>`), planned
whenever a maintenance is saved or an occurrence changes. Each job re-syncs that maintenance at its instant
(`syncMaintenance()` in `src/server/maintenance/occurrences.ts`), so a stale job after a schedule edit does
nothing. The every-minute `maintenance-status` job reconciles all maintenances (jobs lost with Redis, the
first plan after an upgrade) and the worker re-plans every wake-up at boot.

## Effect on monitors and alerts

The worker asks the maintenance resolver before every check (`setMaintenanceResolver` in
`src/server/engine/hooks.ts`, installed by `createMaintenanceResolver()` from `src/server/maintenance`). A
monitor is under maintenance when an active window listing it has an occurrence in progress or verifying
(the persisted `under-maintenance` status), or when one of its parent groups is (recursively). Suppression
therefore follows the actual state: a window that was not started does not suppress, one that runs over
until it is completed does. In that case the check is skipped and a `maintenance` beat is recorded instead: it counts as
**up** in the uptime statistics (Uptime Kuma semantics) and never notifies. When the window ends the next
check decides the real state; a monitor that is still broken then goes DOWN and alerts as usual.

Monitors currently in maintenance show a blue status in the dashboard, the monitor list and the badges.

## Effect on status pages

Attaching a status page to a window makes the page announce it; it does not put the page's monitors into
maintenance (list them under **Monitors** for that). Public pages render, in a **maintenance** block above
the monitor groups, the running occurrences, the next occurrence of each maintenance when it starts within
seven days, and completed or cancelled occurrences for the page's `maintenanceVisibilityHours` (default 24,
set under the page's settings; afterwards they belong to the history page). Each card shows the title,
description, state, the time range in the visitor's local time and the update timeline. The public JSON
(`GET /api/status-pages/:slug/public`) exposes them in its `maintenance` array, running windows first
([Status pages](Status-Pages.md)); everything is read from the persisted occurrences. The page's overall status becomes `maintenance` when its monitors report
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
| `GET`                    | `/api/orgs/:orgId/maintenance/:id/occurrences`           |
| `POST`                   | `…/:id/occurrences/:occurrenceId/updates`                |

`GET …/occurrences` (`maintenance:read`) returns `{ docs }`, newest start first (`?limit=`, default 20).
`POST …/updates` (`maintenance:update`) takes `{ status, message? }`: the current status adds a note, another
allowed status is a transition; it answers `201 { occurrence, maintenance }`, `409` for a transition that is
not allowed (e.g. cancelling a running window) and `400` for an invalid body. The form also carries
`autoStart`, `autoComplete` and `reminders`.

## How status is kept current

The planned windows are a pure function of the document and the clock (`src/server/maintenance/status.ts`).
What actually happens is persisted: the collection hook syncs the occurrences on save (same transaction), the
delayed wake-up jobs apply transitions and reminders at their instants, and the `maintenance-status` job on the
worker's `marmot:maintenance` queue reconciles every window each minute. `status` is written whenever it
changes and the `maintenanceList` realtime event is published so open maintenance pages update live. Reads
(the engine's resolver, status pages) never recompute state. See
[Architecture](Architecture.md#maintenance-windows) for the details.

## Related

- [Monitors](Monitors.md) for the heartbeat state machine.
- [Notifications](Notifications.md) for what does and does not notify.
- [Comparison](Comparison.md) for the Uptime Kuma parity status.
