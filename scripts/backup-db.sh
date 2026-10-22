#!/bin/sh
# Sauvegarde de la base SQLite de BeamMP Panel (v3) : comptes, joueurs
# connus, mods, configs. Copie cohérente à chaud (API de sauvegarde SQLite,
# sûre même pendant une écriture), compressée, gardée 14 jours.
#
# Usage : ./scripts/backup-db.sh [dossier_de_sortie]
# Cron (tous les jours à 3h) — chemin absolu obligatoire :
#   0 3 * * * /opt/app-docker/beammp-panel/scripts/backup-db.sh >> /opt/app-docker/beammp-panel/backup.log 2>&1

set -eu
cd "$(dirname "$0")/.."

OUT_DIR="${1:-./backups}"
RETENTION_DAYS=14
mkdir -p "$OUT_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEST="$OUT_DIR/beammp-panel-$TIMESTAMP.sqlite.gz"
TMP="$OUT_DIR/.beammp-panel-$TIMESTAMP.sqlite.tmp"
trap 'rm -f "$TMP"' EXIT

echo "[backup] SQLite → $DEST"
if ! docker compose exec -T app python -c '
import sqlite3, sys
src = sqlite3.connect("/app/data/panel.db")
dst = sqlite3.connect("/tmp/panel-backup.sqlite")
src.backup(dst); dst.close()
sys.stdout.buffer.write(open("/tmp/panel-backup.sqlite", "rb").read())
' > "$TMP"; then
  echo "[backup] ÉCHEC : copie impossible — rien écrit, rien purgé." >&2
  exit 1
fi
if [ ! -s "$TMP" ] || [ "$(head -c 15 "$TMP")" != "SQLite format 3" ]; then
  echo "[backup] ÉCHEC : la copie n'est pas une base SQLite valide — rien écrit, rien purgé." >&2
  exit 1
fi
gzip -c "$TMP" > "$DEST"
echo "[backup] OK ($(du -h "$DEST" | cut -f1))"
echo "[backup] Purge des sauvegardes de plus de $RETENTION_DAYS jours"
find "$OUT_DIR" -name 'beammp-panel-*.sqlite.gz' -mtime "+$RETENTION_DAYS" -delete
