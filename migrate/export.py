#!/usr/bin/env python3
"""
Export MariaDB → fichiers JSON pour migration offline.

Lancer sur la VM BeamMP (où MariaDB est en local) :
  python3 export.py

Copier ensuite les fichiers *.json générés dans le dossier migrate/ sur APP,
puis lancer : node migrate.js

Variables d'environnement (optionnelles, sinon valeurs par défaut) :
  MARIADB_USER      (défaut: florian)
  MARIADB_PASSWORD  (défaut: demandé interactivement)
  MARIADB_DB        (défaut: beammp_db)
  MARIADB_INSTANCE  (défaut: Officielle)
"""

import json
import subprocess
import sys
import os
import getpass
from datetime import date, datetime

INSTANCE = os.environ.get('MARIADB_INSTANCE', 'Officielle')
USER     = os.environ.get('MARIADB_USER', 'florian')
DB       = os.environ.get('MARIADB_DB', 'beammp_db')
PASSWORD = os.environ.get('MARIADB_PASSWORD', None)

TABLES = {
    'mods':    f'beammp_{INSTANCE}',
    'players': f'beammp_users_{INSTANCE}',
    'users':   'users',
}

def mysql_query(password, table):
    """Lance mysql -B et retourne les lignes sous forme de liste de dicts."""
    cmd = [
        'mysql',
        f'-u{USER}',
        f'-p{password}',
        '--batch',
        '--silent',
        DB,
        '-e', f'SELECT * FROM `{table}`',
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        err = result.stderr.strip()
        # Masquer le mot de passe dans le message d'erreur
        err = err.replace(password, '***')
        raise RuntimeError(f"Erreur MySQL pour `{table}` : {err}")

    lines = result.stdout.strip().split('\n')
    if not lines or lines == ['']:
        return []

    headers = lines[0].split('\t')
    rows = []
    for line in lines[1:]:
        if not line:
            continue
        vals = line.split('\t')
        row = {}
        for i, h in enumerate(headers):
            v = vals[i] if i < len(vals) else None
            row[h] = None if v == 'NULL' else v
        rows.append(row)
    return rows

def serialize(obj):
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    return str(obj)

def main():
    global PASSWORD
    if not PASSWORD:
        PASSWORD = getpass.getpass(f'Mot de passe MySQL pour {USER}@localhost/{DB} : ')

    out_dir = os.path.dirname(os.path.abspath(__file__))

    for key, table in TABLES.items():
        print(f'  Export {table}...', end=' ', flush=True)
        try:
            rows = mysql_query(PASSWORD, table)
            out_path = os.path.join(out_dir, f'{key}.json')
            with open(out_path, 'w', encoding='utf-8') as f:
                json.dump(rows, f, ensure_ascii=False, indent=2, default=serialize)
            print(f'{len(rows)} lignes → {key}.json')
        except RuntimeError as e:
            print(f'IGNORÉ ({e})')

    print('\nFichiers générés :')
    for key in TABLES:
        path = os.path.join(out_dir, f'{key}.json')
        if os.path.exists(path):
            size = os.path.getsize(path)
            print(f'  {key}.json  ({size:,} octets)')

    print('\nCopier ces fichiers dans migrate/ sur APP, puis :')
    print('  node migrate.js')

if __name__ == '__main__':
    main()
