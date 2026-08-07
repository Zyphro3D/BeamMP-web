#!/bin/sh
# Fix volume ownership at startup (runs briefly as root, then drops to node)
chown -R node:node /app/images /beammp 2>/dev/null || true
exec su-exec node "$@"
