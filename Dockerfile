# ─── Étape 1 : interface React ─────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ─── Étape 2 : moteur Python ───────────────────────────────────
FROM python:3.12-slim AS production
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    DATA_DIR=/app/data IMAGES_PATH=/app/images
WORKDIR /app

RUN useradd --create-home --uid 1000 panel \
 && apt-get update && apt-get install -y --no-install-recommends gosu tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server/beammp_panel ./beammp_panel
COPY --from=frontend-builder /app/frontend/dist ./beammp_panel/static
# Clé publique des mises à jour signées (la clé privée ne quitte jamais la machine qui publie)
COPY build/update_public.b64 /tmp/update_public.b64
RUN printf 'PUBLIC_KEY_B64 = "%s"\n' "$(tr -d '\n' < /tmp/update_public.b64)" > beammp_panel/_updkey.py \
 && rm /tmp/update_public.b64

RUN mkdir -p /beammp/resources /app/images /app/data && chown -R panel:panel /app /beammp

COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["python", "-m", "beammp_panel", "--env", "/dev/null"]
