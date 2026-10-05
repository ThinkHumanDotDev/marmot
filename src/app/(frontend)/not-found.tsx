import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-start justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <Link className="underline" href="/">
        Back home
      </Link>
    </main>
  )
}
