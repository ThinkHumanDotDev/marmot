import { getPayload } from 'payload'

import config from '@payload-config'
import { createSetupSession, needsSetup, runSetup, SetupError, setupSchema } from '@/server/setup'

export const dynamic = 'force-dynamic'

const error = (message: string, status: number) =>
  Response.json({ errors: [{ message }] }, { status })

/**
 * `POST /api/setup` — first-run wizard submit. Body: `{ name, email, password, organizationName,
 * organizationSlug }`. Creates the superadmin and their organization in one transaction, logs the
 * user in and sets the `payload-token` cookie. Refuses with 409 once any user exists.
 */
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  if (!(await needsSetup(payload))) return error('Setup has already been completed.', 409)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return error('Request body must be JSON.', 400)
  }

  const parsed = setupSchema.safeParse(body)
  if (!parsed.success) {
    return error(parsed.error.issues[0]?.message ?? 'Invalid input.', 400)
  }

  try {
    const { user, organization } = await runSetup(payload, parsed.data)
    const session = await createSetupSession(
      payload,
      { email: parsed.data.email, password: parsed.data.password },
      request.headers,
    )

    return Response.json(
      {
        user: { id: user.id, email: user.email, name: user.name ?? null },
        organization: { id: organization.id, slug: organization.slug, name: organization.name },
        token: session.token,
        exp: session.exp,
        redirectTo: `/${organization.slug}/monitors`,
      },
      { status: 201, headers: { 'Set-Cookie': session.cookie, 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    if (err instanceof SetupError) return error(err.message, err.status)
    const status =
      err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 500
    if (status >= 500) payload.logger.error({ err }, 'first-run setup failed')
    return error(err instanceof Error ? err.message : 'Setup failed.', status)
  }
}
