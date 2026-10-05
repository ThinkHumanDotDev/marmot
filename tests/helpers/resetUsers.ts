import { getPayload } from 'payload'
import config from '@payload-config'

/**
 * Empties the `users` collection so the instance is back in "needs setup" state. Only the
 * database is reset: a running web server that already observed users keeps reporting
 * `needsSetup: false` until it restarts, which is why the setup e2e spec runs first and in CI only.
 */
export async function deleteAllUsers(): Promise<void> {
  const payload = await getPayload({ config })
  await payload.delete({ collection: 'users', where: { email: { exists: true } } })
}
