# Marmot on Railway: realtime role (socket.io, reached through edge at /socket.io). Node listens on every
# interface, IPv4 and IPv6. The tag follows package.json: scripts/release.sh bumps it and
# scripts/check-railway.mjs enforces it.
FROM ghcr.io/thinkhumandotdev/marmot:0.2.2
# Railway injects its own PORT, so .railway/railway.ts sets PORT=3001 on the service; it only tells
# Railway's healthcheck where to look. The realtime server itself listens on REALTIME_PORT (3001).
ENV MARMOT_ROLE=realtime
