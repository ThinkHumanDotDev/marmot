import { getPayload } from 'payload'
import config from '@payload-config'

export const testUser = {
  email: 'e2e@marmot.local',
  password: 'marmot-e2e-password',
}

/**
 * Seeds a test user for e2e admin tests.
 */
export async function seedTestUser(): Promise<void> {
  const payload = await getPayload({ config })

  // Delete existing test user if any
  await payload.delete({
    collection: 'users',
    where: {
      email: {
        equals: testUser.email,
      },
    },
  })

  // Create fresh test user. Only superadmins may use the Payload admin panel (`users.access.admin`).
  await payload.create({
    collection: 'users',
    data: { ...testUser, superadmin: true },
  })
}

/**
 * Cleans up test user after tests
 */
export async function cleanupTestUser(): Promise<void> {
  const payload = await getPayload({ config })

  await payload.delete({
    collection: 'users',
    where: {
      email: {
        equals: testUser.email,
      },
    },
  })
}
