import { redirect } from 'next/navigation'

/** `/settings` opens the organization tab. */
export default async function SettingsIndexPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  redirect(`/${orgSlug}/settings/organization`)
}
