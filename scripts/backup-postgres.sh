#!/bin/sh
# Sauvegarde du volume postgres_data de BeamMP Panel — aucune sauvegarde
# n'existait avant ce script (seule copie des utilisateurs, joueurs connus,
# mods et historique). À lancer depuis un cron sur l'hôte, pointé sur le
# répertoire du projet (là où se trouve docker-compose.yml et .env).
#
# Usage : ./scripts/backup-postgres.sh [dossier_de_sortie]
# Cron (tous les jours à 3h, garde 14 jours) :
#   0 3 * * * cd /opt/app-docker/beammp-panel && ./scripts/backup-postgres.sh >> /var/log/beammp-panel-backup.log 2>&1

set -eu

cd "$(dirname "$0")/.."

OUT_DIR="${1:-./backups}"
RETENTION_DAYS=14

if [ ! -f .env ]; then
  echo "[backup] .env introuvable — lancer ce script depuis la racine du projet (ou passer le bon dossier)." >&2
  exit 1
fi

POSTGRES_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- || true)
POSTGRES_DB=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2- || true)
POSTGRES_USER="${POSTGRES_USER:-beammp}"
POSTGRES_DB="${POSTGRES_DB:-beammp}"

mkdir -p "$OUT_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEST="$OUT_DIR/beammp-panel-$TIMESTAMP.sql.gz"

echo "[backup] pg_dump $POSTGRES_DB (user $POSTGRES_USER) → $DEST"
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$DEST"

echo "[backup] OK ($(du -h "$DEST" | cut -f1))"

echo "[backup] Purge des sauvegardes de plus de $RETENTION_DAYS jours"
find "$OUT_DIR" -name 'beammp-panel-*.sql.gz' -mtime "+$RETENTION_DAYS" -delete
