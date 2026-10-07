/**
 * Who may view a published status page: everyone (`public`) or visitors who know the page password
 * (`password`). Shared by the collection, the server-side check (`src/server/status-pages/access.ts`)
 * and the builder UI, so it lives outside the collection module.
 */
export const STATUS_PAGE_ACCESS_MODES = ['public', 'password'] as const
export type StatusPageAccessMode = (typeof STATUS_PAGE_ACCESS_MODES)[number]

/** Minimum length of a status page password (enforced by the collection hook). */
export const STATUS_PAGE_PASSWORD_MIN_LENGTH = 8
export const STATUS_PAGE_PASSWORD_MAX_LENGTH = 256
