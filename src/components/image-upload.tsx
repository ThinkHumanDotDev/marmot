'use client'

import { ImageUp, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { cn, initials } from '@/lib/utils'

interface ImageUploadProps {
  /** Current image URL, if any. */
  value: string | null
  /** Text used for the fallback initials and the input's label. */
  label: string
  /** Uploads and attaches the image; a thrown `Error` message is shown as a toast. */
  onUpload: (file: File) => Promise<void>
  onRemove: () => Promise<void> | void
  disabled?: boolean
  shape?: 'circle' | 'square'
  className?: string
}

/**
 * Avatar/logo picker: previews the current image and hands a replacement to `onUpload`, which posts
 * it to the owning document's upload route (`/api/orgs/:orgId/logo`, `/api/account/avatar`).
 */
export function ImageUpload({
  value,
  label,
  onUpload,
  onRemove,
  disabled,
  shape = 'square',
  className,
}: ImageUploadProps) {
  const t = useTranslations('common.imageUpload')
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [busy, setBusy] = React.useState(false)

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      toast.error(t('tooLarge'))
      return
    }
    setBusy(true)
    try {
      await onUpload(file)
    } catch (error) {
      toast.error((error instanceof Error && error.message) || t('failed'))
    } finally {
      setBusy(false)
    }
  }

  async function clear() {
    setBusy(true)
    try {
      await onRemove()
    } finally {
      setBusy(false)
    }
  }

  const rounded = shape === 'circle' ? 'rounded-full' : 'rounded-xl'

  return (
    <div className={cn('flex items-center gap-4', className)}>
      <Avatar className={cn('size-16 border bg-muted', rounded)}>
        {value && <AvatarImage src={value} alt={label} className="object-cover" />}
        <AvatarFallback className={cn('text-lg font-semibold', rounded)}>
          {initials(label)}
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={handleFile}
          disabled={disabled || busy}
          aria-label={t('inputLabel', { label })}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          <ImageUp /> {busy ? t('uploading') : value ? t('replace') : t('upload')}
        </Button>
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || busy}
            onClick={clear}
          >
            <Trash2 /> {t('remove')}
          </Button>
        )}
      </div>
    </div>
  )
}
