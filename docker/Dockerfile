# syntax=docker/dockerfile:1
# Marmot – one image, three roles (web | worker | realtime | all) selected with MARMOT_ROLE.
#
#   docker build -f docker/Dockerfile -t marmot .
#   docker run --rm -e MARMOT_ROLE=web ... marmot            # start a role (default: all)
#   docker run --rm ... marmot migrate                        # run database migrations only
#
# Stages: base → deps (all deps, for the build) + prod-deps (runtime deps only) → builder → runner.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    PAYLOAD_TELEMETRY_DISABLED=1
# libc6-compat: glibc shim for prebuilt native modules; corepack pins the pnpm version from package.json.
RUN apk add --no-cache libc6-compat && corepack enable
WORKDIR /app

# ---- dependencies ----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Runtime dependencies only. The worker/realtime entrypoints (scripts/run-ts.mjs) and `payload migrate`
# transpile TypeScript with tsx, which is a regular dependency; `next start` loads next.config.ts through
# SWC. Neither needs the `typescript` package, so devDependencies stay out of the final image. The
# install itself is a full one followed by `pnpm prune --prod`: @thinkhumandotdev/payload-auth is fetched
# from GitHub and compiled by its `prepare` script, which needs its own development dependencies that a
# `--prod` install would skip (the package then has no dist/ and every process fails to start).
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile && pnpm prune --prod

# ---- build -----------------------------------------------------------------
FROM base AS builder
COPY . .
# Build-time placeholders: the real values are injected at runtime. The placeholder secret is scoped
# to the build command so no secret-looking value is baked into an image layer's ENV.
ENV NODE_ENV=production \
    DATABASE_URL=postgres://build:build@localhost:5432/build \
    DATABASE_ADAPTER=postgres \
    REDIS_URL=redis://localhost:6379
# node_modules is bind-mounted from the deps stage instead of copied, so the builder does not add a
# second copy of it as a layer. .next/cache (Turbopack's ~500 MB persistent cache) is a cache mount:
# it speeds up local rebuilds and stays out of the builder layer, the CI layer cache and the image.
RUN --mount=type=bind,from=deps,source=/app/node_modules,target=/app/node_modules,rw \
    --mount=type=cache,id=marmot-next-cache,target=/app/.next/cache \
    PAYLOAD_SECRET=build-time-placeholder-secret sh -c 'pnpm build && pnpm build:server'

# ---- runtime ---------------------------------------------------------------
FROM base AS runner
LABEL org.opencontainers.image.title="Marmot" \
      org.opencontainers.image.description="Self-hosted status monitor for teams" \
      org.opencontainers.image.source="https://github.com/ThinkHumanDotDev/marmot" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV NODE_ENV=production \
    PORT=3000 \
    REALTIME_PORT=3001 \
    UPLOADS_DIR=/app/uploads
# tini reaps zombies and forwards signals so `docker stop` shuts every role down cleanly.
RUN apk add --no-cache tini \
    && addgroup --system --gid 1001 marmot \
    && adduser --system --uid 1001 --ingroup marmot marmot \
    && mkdir -p /app/uploads \
    && chown -R marmot:marmot /app

COPY --chown=marmot:marmot package.json next.config.ts tsconfig.json ./
COPY --from=prod-deps --chown=marmot:marmot /app/node_modules ./node_modules
COPY --from=builder --chown=marmot:marmot /app/.next ./.next
COPY --from=builder --chown=marmot:marmot /app/public ./public
COPY --from=builder --chown=marmot:marmot /app/src ./src
COPY --from=builder --chown=marmot:marmot /app/dist ./dist
COPY --chown=marmot:marmot --chmod=755 docker/entrypoint.sh /app/entrypoint.sh

USER marmot
EXPOSE 3000 3001
# Media uploads (local storage). Mount a named volume here in production.
VOLUME ["/app/uploads"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/app/entrypoint.sh", "healthcheck"]
ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
CMD ["start"]
