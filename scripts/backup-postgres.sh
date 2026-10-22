#!/bin/sh
# Conservé pour les crons existants : depuis la v3 la base est en SQLite,
# la sauvegarde passe par backup-db.sh.
exec "$(dirname "$0")/backup-db.sh" "$@"
