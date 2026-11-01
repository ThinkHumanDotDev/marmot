# Marmot on Railway: web role (Next.js + Payload: UI, admin, API, status pages). Runs the database
# migrations on start, like the compose stack. The tag follows package.json: scripts/release.sh bumps it
# and scripts/check-railway.mjs enforces it.
FROM ghcr.io/thinkhumandotdev/marmot:0.2.2
# Railway's private network can be IPv6-only; `::` accepts IPv4 and IPv6.
ENV MARMOT_ROLE=web \
    BIND_HOST=::
