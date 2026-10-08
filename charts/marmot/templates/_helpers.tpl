{{/* Chart name, truncated to the 63-character label limit. */}}
{{- define "marmot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name: <release>-marmot unless the release name already contains it. */}}
{{- define "marmot.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "marmot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "marmot.labels" -}}
helm.sh/chart: {{ include "marmot.chart" . }}
{{ include "marmot.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "marmot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "marmot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Labels for one component: (dict "ctx" $ "component" "web") */}}
{{- define "marmot.componentLabels" -}}
{{ include "marmot.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "marmot.componentSelectorLabels" -}}
{{ include "marmot.selectorLabels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "marmot.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "marmot.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "marmot.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}
{{- end }}

{{/* Name of the Secret holding the server secrets (chart-managed or existing). */}}
{{- define "marmot.secretName" -}}
{{- default (include "marmot.fullname" .) .Values.secrets.existingSecret }}
{{- end }}

{{- define "marmot.postgresql.fullname" -}}
{{- printf "%s-postgresql" (include "marmot.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "marmot.postgresql.secretName" -}}
{{- default (include "marmot.postgresql.fullname" .) .Values.postgresql.existingSecret }}
{{- end }}

{{- define "marmot.redis.fullname" -}}
{{- printf "%s-redis" (include "marmot.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "marmot.redis.secretName" -}}
{{- default (include "marmot.redis.fullname" .) .Values.redis.existingSecret }}
{{- end }}

{{- define "marmot.uploadsClaimName" -}}
{{- default (printf "%s-uploads" (include "marmot.fullname" .)) .Values.persistence.existingClaim }}
{{- end }}

{{/*
A random value that survives upgrades: reuse the key of an existing Secret when there is one.
(dict "ctx" $ "secret" "<name>" "key" "<key>" "length" 32)
*/}}
{{- define "marmot.persistentRandom" -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace .secret }}
{{- if and $existing $existing.data (hasKey $existing.data .key) }}
{{- index $existing.data .key | b64dec }}
{{- else }}
{{- randAlphaNum (int .length) }}
{{- end }}
{{- end }}

{{/* "true" when the release runs the Marmot server (every mode but `probes`). */}}
{{- define "marmot.server" -}}
{{- if ne .Values.mode "probes" }}true{{ end }}
{{- end }}

{{/* Fails early on settings that cannot work. */}}
{{- define "marmot.validate" -}}
{{- if not (has .Values.mode (list "split" "all" "probes")) }}
{{- fail "mode must be `split`, `all` or `probes`" }}
{{- end }}
{{- if eq .Values.mode "probes" }}
{{- if not .Values.probes.agents }}
{{- fail "mode=probes deploys only probe agents: add at least one entry to probes.agents" }}
{{- end }}
{{- else }}
{{- if not (has .Values.database.adapter (list "postgres" "mongodb")) }}
{{- fail "database.adapter must be `postgres` or `mongodb`" }}
{{- end }}
{{- if and (eq .Values.database.adapter "mongodb") .Values.postgresql.enabled }}
{{- fail "postgresql.enabled cannot be combined with database.adapter=mongodb; set secrets.databaseUrl to your MongoDB" }}
{{- end }}
{{- if not .Values.secrets.existingSecret }}
{{- if and (not .Values.postgresql.enabled) (not .Values.secrets.databaseUrl) }}
{{- fail "set secrets.databaseUrl (or secrets.existingSecret with DATABASE_URL), or enable the bundled postgresql" }}
{{- end }}
{{- if and (not .Values.redis.enabled) (not .Values.secrets.redisUrl) }}
{{- fail "set secrets.redisUrl (or secrets.existingSecret with REDIS_URL), or enable the bundled redis" }}
{{- end }}
{{- end }}
{{- if and (not .Values.migrations.enabled) (or (gt (int .Values.web.replicas) 1) .Values.web.autoscaling.enabled) (eq .Values.mode "split") }}
{{- fail "migrations.enabled=false lets every web pod migrate on start; keep web.replicas=1 without autoscaling, or enable the migration Job" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Environment shared by every Marmot server container (web, worker, realtime, all, migrations).
(dict "ctx" $ "role" "web"), plus "migrate" true for the migration Job.
*/}}
{{- define "marmot.env" -}}
{{- $ctx := .ctx -}}
- name: MARMOT_ROLE
  value: {{ .role | quote }}
- name: NEXT_PUBLIC_SERVER_URL
  value: {{ $ctx.Values.serverUrl | quote }}
- name: DATABASE_ADAPTER
  value: {{ $ctx.Values.database.adapter | quote }}
- name: UPLOADS_DIR
  value: /app/uploads
- name: PORT
  value: {{ $ctx.Values.web.service.port | quote }}
- name: REALTIME_PORT
  value: {{ $ctx.Values.realtime.service.port | quote }}
- name: SKIP_MIGRATIONS
  value: {{ ternary "true" "false" (and $ctx.Values.migrations.enabled (not .migrate)) | quote }}
{{- range $key, $value := $ctx.Values.config }}
- name: {{ $key }}
  value: {{ $value | toString | quote }}
{{- end }}
{{- if $ctx.Values.postgresql.enabled }}
- name: MARMOT_POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "marmot.postgresql.secretName" $ctx }}
      key: {{ $ctx.Values.postgresql.passwordKey }}
- name: DATABASE_URL
  value: {{ printf "postgres://%s:$(MARMOT_POSTGRES_PASSWORD)@%s:5432/%s" $ctx.Values.postgresql.username (include "marmot.postgresql.fullname" $ctx) $ctx.Values.postgresql.database | quote }}
{{- end }}
{{- if $ctx.Values.redis.enabled }}
- name: MARMOT_REDIS_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "marmot.redis.secretName" $ctx }}
      key: {{ $ctx.Values.redis.passwordKey }}
- name: REDIS_URL
  value: {{ printf "redis://:$(MARMOT_REDIS_PASSWORD)@%s:6379" (include "marmot.redis.fullname" $ctx) | quote }}
{{- end }}
{{- with $ctx.Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{- define "marmot.envFrom" -}}
- secretRef:
    name: {{ include "marmot.secretName" . }}
{{- with .Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* Pod-level settings shared by the Marmot server pods. */}}
{{- define "marmot.podCommon" -}}
serviceAccountName: {{ include "marmot.serviceAccountName" . }}
automountServiceAccountToken: {{ .Values.serviceAccount.automountServiceAccountToken }}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- end }}

{{/* Annotations that roll the pods when the secret values change. */}}
{{- define "marmot.podAnnotations" -}}
checksum/secret: {{ toJson .Values.secrets | sha256sum }}
{{- with .Values.podAnnotations }}
{{ toYaml . }}
{{- end }}
{{- end }}
