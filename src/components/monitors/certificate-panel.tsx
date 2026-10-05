import { ShieldCheck } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * TLS certificate panel. Certificate capture and expiry notifications land with the cert-expiry
 * issue; until then this explains what will appear here.
 */
export function CertificatePanel({ expiryNotification }: { expiryNotification?: boolean | null }) {
  return (
    <Card className="gap-3" data-testid="certificate-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
          Certificate
        </CardTitle>
        <CardDescription>
          Issuer, validity window and days until expiry of the server certificate.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Certificate details are captured on the next HTTPS check once certificate monitoring is
        enabled for this instance.
        {expiryNotification
          ? ' Expiry notifications are switched on for this monitor.'
          : ' Turn on "Certificate expiry notification" in the monitor settings to be warned before it expires.'}
      </CardContent>
    </Card>
  )
}
