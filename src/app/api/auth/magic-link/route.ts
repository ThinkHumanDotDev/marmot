import { handleMagicLinkRequest } from '@/server/auth/magic-link'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/magic-link `{ email, next? }` → 202 `{ sent: true }`
 *
 * Mails a single-use sign-in link (15 minutes) when the address may sign in or sign up (#164). The
 * answer is the same whether or not an account exists; 403 while the method is off or in the
 * SSO-only mode, 400 for something that is not an address, 429 when rate limited per client and
 * per address. See `src/server/auth/magic-link.ts`.
 */
export async function POST(request: Request) {
  return handleMagicLinkRequest(request)
}
