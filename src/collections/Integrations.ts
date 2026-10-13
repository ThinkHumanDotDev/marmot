import type { CollectionConfig, FieldAccess } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup } from '@/i18n/admin'
import { DECLARED_INCIDENT_SEVERITIES } from '@/lib/declared-incidents'
import {
  DEFAULT_EMAIL_RESOLVED_KEYWORD,
  DEFAULT_GENERIC_MAPPING,
  INTEGRATION_FORMATS,
  RULE_IMPACTS,
  RULE_INCIDENT_MODES,
  RULE_MATCH_OPERATORS,
} from '@/lib/inbound-alerts'
import { validateIntegration } from '@/server/integrations/validate'

const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }))

/** Written by the server only (`overrideAccess: true` bypasses field access). */
const serverOnly: FieldAccess = () => false

/**
 * Inbound alert integrations (#152): an external alerting system (Alertmanager, Grafana, any JSON
 * sender, email) posts to `POST /api/inbound/<token>` or mails `<token>@INBOUND_EMAIL_DOMAIN`, and
 * ordered `rules` turn matching alerts into component impacts (opt-in per rule), draft (declared)
 * or public status-page incidents, and push monitor heartbeats. Only the SHA-256 of the token is
 * stored; the token is shown once by `POST /api/orgs/:orgId/integrations` and `…/rotate-token`.
 * Alert state lives in `integration-alerts`, the received payloads in `integration-events`.
 */
export const Integrations: CollectionConfig = {
  slug: 'integrations',
  admin: {
    useAsTitle: 'name',
    group: adminGroup('monitoring'),
    defaultColumns: ['name', 'format', 'active', 'lastEventAt'],
  },
  access: {
    read: orgScoped('integration:read'),
    create: orgScoped('integration:manage'),
    update: orgScoped('integration:manage'),
    delete: orgScoped('integration:manage'),
  },
  hooks: {
    beforeChange: [validateIntegration],
  },
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    { name: 'name', type: 'text', required: true, maxLength: 100 },
    {
      type: 'row',
      fields: [
        {
          name: 'format',
          type: 'select',
          required: true,
          defaultValue: 'alertmanager',
          options: options(INTEGRATION_FORMATS),
        },
        { name: 'active', type: 'checkbox', defaultValue: true },
      ],
    },
    {
      name: 'tokenHash',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      access: { read: serverOnly, update: serverOnly, create: serverOnly },
      admin: { hidden: true },
    },
    {
      name: 'tokenPrefix',
      type: 'text',
      required: true,
      access: { update: serverOnly, create: serverOnly },
      admin: { readOnly: true },
    },
    {
      // JSON paths of the generic format (`src/lib/inbound-alerts.ts` → `valueAtPath`).
      name: 'generic',
      type: 'group',
      fields: [
        { name: 'alertsPath', type: 'text', defaultValue: DEFAULT_GENERIC_MAPPING.alertsPath },
        { name: 'titlePath', type: 'text', defaultValue: DEFAULT_GENERIC_MAPPING.titlePath },
        { name: 'statusPath', type: 'text', defaultValue: DEFAULT_GENERIC_MAPPING.statusPath },
        {
          name: 'severityPath',
          type: 'text',
          defaultValue: DEFAULT_GENERIC_MAPPING.severityPath,
        },
        {
          name: 'dedupKeyPath',
          type: 'text',
          defaultValue: DEFAULT_GENERIC_MAPPING.dedupKeyPath,
        },
        {
          name: 'descriptionPath',
          type: 'text',
          defaultValue: DEFAULT_GENERIC_MAPPING.descriptionPath,
        },
        {
          name: 'resolvedValues',
          type: 'text',
          defaultValue: DEFAULT_GENERIC_MAPPING.resolvedValues,
        },
      ],
    },
    {
      name: 'emailResolvedKeyword',
      type: 'text',
      maxLength: 100,
      defaultValue: DEFAULT_EMAIL_RESOLVED_KEYWORD,
    },
    {
      name: 'rules',
      type: 'array',
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'name', type: 'text', maxLength: 100 },
            { name: 'enabled', type: 'checkbox', defaultValue: true },
          ],
        },
        {
          type: 'row',
          fields: [
            { name: 'matchField', type: 'text', maxLength: 100 },
            {
              name: 'matchOperator',
              type: 'select',
              defaultValue: 'equals',
              options: options(RULE_MATCH_OPERATORS),
            },
            { name: 'matchValue', type: 'text', maxLength: 200 },
          ],
        },
        {
          // Opt-in: without it the rule never changes what visitors of a status page see.
          name: 'updateComponent',
          type: 'checkbox',
          defaultValue: false,
        },
        {
          type: 'row',
          fields: [
            { name: 'statusPage', type: 'relationship', relationTo: 'status-pages' },
            // A component id (group row id of the page, see src/lib/status-page-components.ts).
            { name: 'component', type: 'text' },
            {
              name: 'impact',
              type: 'select',
              defaultValue: 'partial_outage',
              options: options(RULE_IMPACTS),
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'incident',
              type: 'select',
              defaultValue: 'none',
              options: options(RULE_INCIDENT_MODES),
            },
            {
              name: 'severity',
              type: 'select',
              defaultValue: 'major',
              options: options(DECLARED_INCIDENT_SEVERITIES),
            },
          ],
        },
        // Drives a push monitor: firing records a failure, resolved a success.
        { name: 'monitor', type: 'relationship', relationTo: 'monitors' },
      ],
    },
    {
      name: 'lastEventAt',
      type: 'date',
      access: { update: serverOnly, create: serverOnly },
      admin: { readOnly: true },
    },
    {
      name: 'createdBy',
      type: 'relationship',
      relationTo: 'users',
      access: { update: serverOnly, create: serverOnly },
      admin: { readOnly: true },
    },
  ],
  timestamps: true,
}
