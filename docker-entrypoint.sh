#!/bin/sh
# Corrige les droits des volumes au démarrage (brièvement en root), puis
# repasse sur l'utilisateur sans privilège. Même uid 1000 que l'image v2
# (utilisateur node) : les fichiers déjà écrits restent accessibles.
chown -R panel:panel /app/images /app/data /beammp 2>/dev/null || true
exec gosu panel "$@"
