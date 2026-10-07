# Marmot on Railway: Redis configured like docker/docker-compose.yml. BullMQ must never lose keys
# (noeviction) and job schedulers must survive restarts (save + a Railway volume on /data).
# Listens on IPv4 and IPv6 for the private network; REDIS_PASSWORD comes from the template. Runs as
# root because Railway mounts volumes root-owned.
FROM redis:7-alpine
CMD ["sh", "-c", "exec redis-server --bind '* -::*' --requirepass \"$REDIS_PASSWORD\" --maxmemory-policy noeviction --save 60 1 --dir /data"]
