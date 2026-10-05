# syntax=docker/dockerfile:1
# Marmot – single image, three roles (web | worker | realtime) selected with MARMOT_ROLE.

FROM node:26-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 PAYLOAD_TELEMETRY_DISABLED=1
RUN apk add --no-cache libc6-compat && corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time placeholders: the real values are injected at runtime.
ENV PAYLOAD_SECRET=build-time-placeholder-secret DATABASE_URL=postgres://build:build@localhost:5432/build DATABASE_ADAPTER=postgres REDIS_URL=redis://localhost:6379
RUN pnpm build && pnpm prune --prod

FROM base AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 UPLOADS_DIR=/app/uploads
RUN addgroup --system --gid 1001 marmot && adduser --system --uid 1001 marmot
COPY --from=builder --chown=marmot:marmot /app/package.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=builder --chown=marmot:marmot /app/node_modules ./node_modules
COPY --from=builder --chown=marmot:marmot /app/.next ./.next
COPY --from=builder --chown=marmot:marmot /app/public ./public
COPY --from=builder --chown=marmot:marmot /app/src ./src
COPY --chown=marmot:marmot docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh && mkdir -p /app/uploads && chown marmot:marmot /app/uploads
USER marmot
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD /app/entrypoint.sh healthcheck
ENTRYPOINT ["/app/entrypoint.sh"]
