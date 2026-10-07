import { useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'

/** Marmot mark: a rounded tile with a signal "pulse". Pure CSS/SVG so it inherits theme tokens. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm',
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="size-5"
        strokeWidth={2.4}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 13.5h3.2l2.3-6 3.4 10 2.6-7 1.8 3h4.7"
        />
      </svg>
    </span>
  )
}

export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string
  showWordmark?: boolean
}) {
  const t = useTranslations('common')
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      {showWordmark && (
        <span className="text-[15px] font-semibold tracking-tight text-foreground">
          {t('appName')}
        </span>
      )}
    </span>
  )
}
