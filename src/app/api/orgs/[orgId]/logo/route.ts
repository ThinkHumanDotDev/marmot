import { removeOrgLogo, uploadOrgLogo } from '@/server/media/routes'

export const dynamic = 'force-dynamic'

/** POST /api/orgs/:orgId/logo (multipart `file`) — upload and set the organization logo. */
export const POST = uploadOrgLogo

/** DELETE /api/orgs/:orgId/logo — clear the organization logo. */
export const DELETE = removeOrgLogo
