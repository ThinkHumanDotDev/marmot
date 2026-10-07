import { Bell, Mail, MessageSquare, Smartphone, Webhook, type LucideIcon } from 'lucide-react'

import type { NotificationProviderGroup } from '@/server/notification-providers/types'
import { cn } from '@/lib/utils'

const GROUP_ICONS: Record<NotificationProviderGroup, LucideIcon> = {
  chat: MessageSquare,
  push: Smartphone,
  email: Mail,
  generic: Webhook,
}

/** Icon of a notification provider, by its picker group (chat, push, email, generic). */
export function ProviderIcon({
  group,
  className,
}: {
  group: NotificationProviderGroup | null | undefined
  className?: string
}) {
  const Icon = (group && GROUP_ICONS[group]) || Bell
  return <Icon className={cn('size-4 shrink-0 text-muted-foreground', className)} aria-hidden />
}
