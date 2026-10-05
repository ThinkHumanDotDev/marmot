import { getPayload } from 'payload'
import config from '@payload-config'

/**
 * Empties the `users` collection so the instance is back in "needs setup" state. The setup e2e
 * spec runs first (file name prefix) and in CI only so it never races the other specs' seeds.
 */
export async function deleteAllUsers(): Promise<void> {
  const payload = await getPayload({ config })
  await payload.delete({ collection: 'users', where: { email: { exists: true } } })
}
