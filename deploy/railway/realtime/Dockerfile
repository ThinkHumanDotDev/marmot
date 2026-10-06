# Marmot on Railway: realtime role (socket.io, reached through edge at /socket.io). Node listens on every
# interface, IPv4 and IPv6. The tag follows package.json: scripts/release.sh bumps it and
# scripts/check-railway.mjs enforces it.
FROM ghcr.io/thinkhumandotdev/marmot:0.1.0
# PORT tells Railway which port to health-check; the realtime server itself reads REALTIME_PORT (3001).
ENV MARMOT_ROLE=realtime \
    PORT=3001
