"""Import des données de la v2 (PostgreSQL) dans la base SQLite de la v3.

Deux sources possibles :
  --dump fichier.sql[.gz]   sauvegarde pg_dump au format texte (celle que
                            scripts/backup-postgres.sh produit chaque nuit)
  --dsn postgresql://…      connexion directe (nécessite psycopg)

Usage : python -m beammp_panel.importer --dump backups/x.sql.gz --db data/panel.db
Les identifiants sont conservés : les configs pré-établies, qui référencent
des ids de mods, restent valides. Les mots de passe (bcrypt) passent tels
quels, chaque compte garde le sien.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .db import init_db

TABLES = ["users", "known_players", "account_requests", "mods", "config_presets"]
TIMESTAMP_COLUMNS = {"created_at", "first_seen", "last_seen", "requested_at", "reviewed_at"}
JSON_COLUMNS = {"description", "metadata"}
BOOL_COLUMNS = {"active", "is_official"}

_COPY_RE = re.compile(r"^COPY (?:public\.)?(\w+) \(([^)]*)\) FROM stdin;$")
_ESCAPES = {"t": "\t", "n": "\n", "r": "\r", "\\": "\\", "b": "\b", "f": "\f", "v": "\v"}


def _unescape(field: str) -> str | None:
    if field == r"\N":
        return None
    out, i = [], 0
    while i < len(field):
        c = field[i]
        if c == "\\" and i + 1 < len(field):
            nxt = field[i + 1]
            if nxt in _ESCAPES:
                out.append(_ESCAPES[nxt])
                i += 2
                continue
            m = re.match(r"[0-7]{1,3}", field[i + 1:])
            if m:
                out.append(chr(int(m.group(0), 8)))
                i += 1 + len(m.group(0))
                continue
            out.append(nxt)
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def iter_dump(path: Path) -> Iterator[tuple[str, dict[str, str | None]]]:
    """Lignes (table, {colonne: valeur texte}) des blocs COPY d'un pg_dump."""
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as f:
        table: str | None = None
        cols: list[str] = []
        for raw in f:
            line = raw.rstrip("\n")
            if table is None:
                m = _COPY_RE.match(line)
                if m and m.group(1) in TABLES:
                    table = m.group(1)
                    cols = [c.strip().strip('"') for c in m.group(2).split(",")]
                continue
            if line == r"\.":
                table = None
                continue
            values = [_unescape(v) for v in line.split("\t")]
            yield table, dict(zip(cols, values))


def iter_dsn(dsn: str) -> Iterator[tuple[str, dict[str, Any]]]:
    import psycopg  # dépendance facultative, seulement pour cet usage
    with psycopg.connect(dsn) as conn:
        for table in TABLES:
            with conn.cursor() as cur:
                cur.execute(f"SELECT * FROM {table}")
                cols = [d.name for d in cur.description]
                for row in cur:
                    yield table, dict(zip(cols, row))


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip().replace(" ", "T", 1)
        # pg_dump : « 2025-08-30 12:00:00.123456+00 » → ISO accepté par fromisoformat
        text = re.sub(r"([+-]\d{2})$", r"\1:00", text)
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return str(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _convert(table: str, row: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for col, value in row.items():
        if col in TIMESTAMP_COLUMNS:
            value = _iso(value)
        elif col in BOOL_COLUMNS:
            value = 1 if value in (True, "t", "true", 1) else 0
        elif col in JSON_COLUMNS:
            if value is not None and not isinstance(value, str):
                value = json.dumps(value, ensure_ascii=False)
        elif col == "mod_ids":
            if isinstance(value, str):
                inner = value.strip("{}")
                value = [int(x) for x in inner.split(",") if x.strip()] if inner else []
            value = json.dumps(list(value or []))
        out[col] = value
    if table == "known_players" and not out.get("first_seen"):
        out["first_seen"] = out.get("last_seen") or _iso(datetime.now(timezone.utc))
    return out


def import_rows(db_path: str, rows: Iterator[tuple[str, dict[str, Any]]], *, force: bool = False) -> dict[str, int]:
    db = init_db(db_path)
    if not force and db.one("SELECT COUNT(*) AS n FROM users")["n"] > 0:
        raise SystemExit("La base SQLite contient déjà des comptes : import annulé (--force pour écraser).")
    counts = {t: 0 for t in TABLES}
    buffered: dict[str, list[dict[str, Any]]] = {t: [] for t in TABLES}
    for table, row in rows:
        buffered[table].append(_convert(table, row))
    with db.transaction() as t:
        for table in reversed(TABLES):
            t.run(f"DELETE FROM {table}")
        for table in TABLES:  # users d'abord : account_requests y fait référence
            for row in buffered[table]:
                cols = list(row)
                t.run(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                      [row[c] for c in cols])
                counts[table] += 1
    return counts


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Importe la base PostgreSQL de la v2 dans SQLite")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--dump", type=Path, help="sauvegarde pg_dump (.sql ou .sql.gz)")
    src.add_argument("--dsn", help="chaîne de connexion PostgreSQL")
    parser.add_argument("--db", required=True, help="base SQLite de destination")
    parser.add_argument("--force", action="store_true", help="écraser une base déjà remplie")
    args = parser.parse_args(argv)
    rows = iter_dump(args.dump) if args.dump else iter_dsn(args.dsn)
    counts = import_rows(args.db, rows, force=args.force)
    for table, n in counts.items():
        print(f"{table:18} {n}")
    print(f"Import terminé → {args.db}", file=sys.stderr)


if __name__ == "__main__":
    main()
