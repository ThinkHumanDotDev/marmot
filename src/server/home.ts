/**
 * Where `/` sends a visitor. Kept free of Payload and request APIs so the decision is testable on
 * its own; `src/app/(frontend)/page.tsx` gathers the inputs and acts on the result.
 */
export type HomeRoute = { kind: 'redirect'; to: string } | { kind: 'landing' }

export interface HomeRouteInput {
  /** Home path of the signed-in user (`homePathFor`), or `null` when signed out. */
  userHome: string | null
  /** The instance has no user yet and must go through the first-run wizard. */
  setupNeeded: boolean
  /** `LANDING_PAGE_ENABLED`: show the marketing page instead of the login redirect. */
  landingEnabled: boolean
}

/**
 * Signed-in users always go to their organization, a fresh install always goes to `/setup`; only
 * signed-out visitors on an instance with the landing page enabled stay on `/`.
 */
export function resolveHomeRoute({
  userHome,
  setupNeeded,
  landingEnabled,
}: HomeRouteInput): HomeRoute {
  if (userHome) return { kind: 'redirect', to: userHome }
  if (setupNeeded) return { kind: 'redirect', to: '/setup' }
  if (landingEnabled) return { kind: 'landing' }
  return { kind: 'redirect', to: '/login' }
}
