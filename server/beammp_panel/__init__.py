"""BeamMP Panel — moteur Python (v3).

Réécriture du backend Node/Fastify de la v2 : même API HTTP (le frontend
React n'a pas changé), SQLite à la place de PostgreSQL, aucune dépendance
native lourde (Pillow remplace sharp), pour pouvoir livrer une appli prête
à l'emploi sous Linux et Windows sans Docker.
"""

# Garder en phase avec la dernière entrée de CHANGELOG.md.
VERSION = "3.3.1"
