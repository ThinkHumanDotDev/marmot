# Marmot on Railway: the only public service. Caddy with the bundled Caddyfile sends /socket.io/* to
# realtime and everything else to web over Railway's private network; Railway terminates TLS.
# Built from the repository root (.railway/railway.ts sets the Dockerfile path), so docker/Caddyfile is
# in the build context.
FROM caddy:2-alpine
COPY docker/Caddyfile /etc/caddy/Caddyfile
# Plain HTTP on 8080 behind Railway's edge (.railway/railway.ts sets PORT=8080 to match). The upstreams
# match the template's service names.
ENV SITE_ADDRESS=:8080 \
    WEB_UPSTREAM=web.railway.internal:3000 \
    REALTIME_UPSTREAM=realtime.railway.internal:3001
EXPOSE 8080
