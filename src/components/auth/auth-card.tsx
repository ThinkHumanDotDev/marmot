import Link from 'next/link'
import * as React from 'react'

import { Logo } from '@/components/logo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface AuthCardProps {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  /** Links rendered under the card (e.g. "No account? Sign up"). */
  footer?: React.ReactNode
}

export function AuthCard({ title, description, children, footer }: AuthCardProps) {
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-6">
      <Link href="/" aria-label="Marmot">
        <Logo />
      </Link>
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      {footer && <div className="text-center text-sm text-muted-foreground">{footer}</div>}
    </div>
  )
}
