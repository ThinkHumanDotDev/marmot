import { CheckCircle2, XCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ASSERTION_COMPARATORS, type AssertionResult } from '@/lib/validation/assertions'

export { parseAssertionResults } from '@/lib/assertion-results'

/**
 * Per-assertion outcome of the monitor's last check (#96): what was checked, the condition, the
 * observed value and the verdict. Checks derived from the monitor's own settings (accepted status
 * codes, keyword, JSON query) are marked as such.
 */
export function AssertionResultsCard({ results }: { results: AssertionResult[] }) {
  const t = useTranslations('monitors.detail.assertions')
  const tForm = useTranslations('monitors.form.assertions')

  const comparatorLabel = (comparator: AssertionResult['comparator']) =>
    (ASSERTION_COMPARATORS as readonly string[]).includes(comparator)
      ? tForm(`comparators.${comparator as (typeof ASSERTION_COMPARATORS)[number]}`)
      : t('inRange')

  return (
    <Card className="gap-3" data-testid="assertion-results">
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">{t('check')}</TableHead>
              <TableHead>{t('condition')}</TableHead>
              <TableHead>{t('actual')}</TableHead>
              <TableHead className="pr-6 text-right">{t('result')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((result, index) => (
              <TableRow key={index} data-testid="assertion-result">
                <TableCell className="pl-6 align-top">
                  <div className="flex flex-col gap-1">
                    <span className="text-sm">{tForm(`kinds.${result.kind}`)}</span>
                    {result.target && (
                      <code className="text-xs break-all text-muted-foreground">
                        {result.target}
                      </code>
                    )}
                    {result.legacy && (
                      <Badge variant="outline" className="w-fit text-[10px]">
                        {t('legacy')}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="align-top text-sm">
                  {comparatorLabel(result.comparator)}
                  {result.expected !== null && (
                    <code className="ml-1 text-xs break-all">{result.expected}</code>
                  )}
                </TableCell>
                <TableCell className="max-w-64 align-top text-xs">
                  {result.error ? (
                    <span className="text-destructive">{result.error}</span>
                  ) : result.actual === null ? (
                    <span className="text-muted-foreground">{t('none')}</span>
                  ) : (
                    <code className="line-clamp-3 break-all">{result.actual}</code>
                  )}
                </TableCell>
                <TableCell className="pr-6 text-right align-top">
                  {result.passed ? (
                    <span className="inline-flex items-center gap-1 text-sm text-status-up-text">
                      <CheckCircle2 className="size-4" aria-hidden /> {t('passed')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-sm text-destructive">
                      <XCircle className="size-4" aria-hidden /> {t('failed')}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
