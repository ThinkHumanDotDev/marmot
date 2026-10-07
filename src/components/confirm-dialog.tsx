'use client'

import { useTranslations } from 'next-intl'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  /** When set, the user must type this exact value before the action is enabled. */
  confirmText?: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => Promise<void> | void
  children?: React.ReactNode
}

/** Confirmation modal, optionally with a "type to confirm" guard for irreversible actions. */
export function ConfirmDialog({ open, onOpenChange, ...body }: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false)
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      {/* Radix unmounts the content when closed, so the typed text resets on every open. */}
      <DialogContent>
        <ConfirmBody
          {...body}
          pending={pending}
          setPending={setPending}
          close={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function ConfirmBody({
  title,
  description,
  confirmText,
  confirmLabel,
  destructive = false,
  onConfirm,
  children,
  pending,
  setPending,
  close,
}: Omit<ConfirmDialogProps, 'open' | 'onOpenChange'> & {
  pending: boolean
  setPending: (value: boolean) => void
  close: () => void
}) {
  const t = useTranslations('common.confirmDialog')
  const [typed, setTyped] = React.useState('')
  const inputId = React.useId()
  const ready = !confirmText || typed.trim() === confirmText

  async function confirm() {
    setPending(true)
    try {
      await onConfirm()
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      {children}
      {confirmText && (
        <div className="grid gap-2">
          <Label htmlFor={inputId}>
            {t.rich('typeToConfirm', {
              value: () => (
                <span className="font-mono font-semibold text-foreground">{confirmText}</span>
              ),
            })}
          </Label>
          <Input
            id={inputId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={close} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button
          variant={destructive ? 'destructive' : 'default'}
          onClick={confirm}
          disabled={!ready || pending}
        >
          {pending ? t('working') : (confirmLabel ?? t('confirm'))}
        </Button>
      </DialogFooter>
    </>
  )
}
