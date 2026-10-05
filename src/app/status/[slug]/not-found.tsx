import { Compass } from 'lucide-react'

export default function StatusPageNotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Compass className="size-5" aria-hidden />
      </span>
      <h1 className="text-base font-semibold">Status page not found</h1>
      <p className="text-sm text-muted-foreground">
        This status page does not exist or has not been published.
      </p>
    </main>
  )
}
