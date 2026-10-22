#!/bin/sh
# Passage de BeamMP Panel v2 (Node + PostgreSQL) à v3 (Python + SQLite).
#
# À lancer UNE fois, depuis la racine du projet, par l'utilisateur qui gère
# Docker. Le script n'existe pas encore dans une copie v2 : on le lit
# directement dans la branche v3 :
#   git fetch origin && git show origin/v3-python:scripts/upgrade-to-v3.sh | sh -s -- [branche-ou-tag]
#
# Étapes : sauvegarde pg_dump fraîche (avec la v2 encore en place) → bascule
# du code → construction → import de la sauvegarde dans SQLite → démarrage
# → vérification. Le volume PostgreSQL n'est jamais supprimé : retour arrière
# possible (voir la fin du script).

set -eu
# Dossier courant s'il contient le projet (cas « | sh -s »), sinon celui du script.
if [ -f docker-compose.yml ] && [ -d .git ]; then :; else cd "$(dirname "$0")/.."; fi

TARGET="${1:-v3-python}"
PREV_REF=$(git rev-parse --abbrev-ref HEAD)
STAMP=$(date +%Y%m%d-%H%M%S)
DUMP="backups/pre-3.0.0-$STAMP.sql.gz"

[ -f .env ] || { echo "[v3] .env introuvable : lancer depuis la racine du projet." >&2; exit 1; }
if grep -q '"version": "3\.' frontend/package.json 2>/dev/null && [ -d server ]; then
  echo "[v3] Le code est déjà en v3 ; pour un simple redéploiement : docker compose up -d --build" >&2
  exit 1
fi

echo "[v3] 1/6 Sauvegarde de la base v2 → $DUMP"
POSTGRES_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- || true)
POSTGRES_DB=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2- || true)
mkdir -p backups
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-beammp}" "${POSTGRES_DB:-beammp}" > "backups/.v3-$STAMP.sql"
grep -q "PostgreSQL database dump" "backups/.v3-$STAMP.sql" || { echo "[v3] ÉCHEC : dump vide ou invalide, rien changé." >&2; exit 1; }
gzip -c "backups/.v3-$STAMP.sql" > "$DUMP" && rm -f "backups/.v3-$STAMP.sql"

echo "[v3] 2/6 Code → $TARGET (actuel : $PREV_REF)"
git fetch --quiet origin
git checkout --quiet "$TARGET"
git pull --quiet --ff-only origin "$TARGET" 2>/dev/null || true

echo "[v3] 3/6 Construction de l'image"
docker compose build app

echo "[v3] 4/6 Arrêt de la v2 et import de la sauvegarde dans SQLite"
docker compose stop app
docker compose run --rm --no-deps -T app python -m beammp_panel.importer --dump "/app/$DUMP" --db /app/data/panel.db

echo "[v3] 5/6 Démarrage de la v3"
docker compose up -d app
docker compose --profile legacy stop postgres >/dev/null 2>&1 || true

echo "[v3] 6/6 Vérification"
PORT=$(grep -E '^APP_PORT=' .env | cut -d= -f2- || true)
PORT="${PORT:-3000}"
i=0
until curl -fsS -D - -o /dev/null "http://127.0.0.1:$PORT/api/info" 2>/dev/null | grep -qi '^x-beammp-panel-version: 3\.'; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "[v3] ÉCHEC : le panel v3 ne répond pas. Journaux : docker compose logs app" >&2
    echo "[v3] Retour à la v2 : git checkout $PREV_REF && docker compose --profile legacy up -d --build" >&2
    exit 1
  fi
  sleep 2
done
echo "[v3] OK : BeamMP Panel v3 en ligne sur le port $PORT (sauvegarde v2 : $DUMP)"
echo "[v3] Retour arrière si besoin : git checkout $PREV_REF && docker compose --profile legacy up -d --build"
