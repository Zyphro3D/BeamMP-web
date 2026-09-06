# ─── Stage 1 : Build frontend ─────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ─── Stage 2 : Build backend ──────────────────────────────────
FROM node:22-alpine AS backend-builder
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/ ./
RUN npm run build

# ─── Stage 3 : Production image ───────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

# Install only production deps
COPY backend/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy built artifacts
COPY --from=backend-builder /app/backend/dist ./dist
COPY --from=frontend-builder /app/frontend/dist ./public

# su-exec : passe de root à node après avoir corrigé les droits des volumes
RUN apk add --no-cache su-exec

# Directories for BeamMP mounts
RUN mkdir -p /beammp/resources /app/images && \
    chown -R node:node /app /beammp

COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
