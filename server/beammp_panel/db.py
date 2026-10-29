"""Base SQLite — remplace PostgreSQL.

Un seul fichier, aucun serveur à installer : c'est ce qui permet une appli
prête à l'emploi. Les colonnes JSONB/INTEGER[] de la v2 sont stockées en
texte JSON et décodées à la lecture, pour que l'API renvoie exactement les
mêmes formes qu'avant (objets, listes, booléens, dates ISO).
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'moderator'
              CHECK (role IN ('superadmin', 'admin', 'moderator')),
  created_at  TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS known_players (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id      TEXT NOT NULL DEFAULT 'default',
  beammp_username  TEXT NOT NULL,
  connection_count INTEGER NOT NULL DEFAULT 0,
  first_seen       TEXT NOT NULL,
  last_seen        TEXT,
  total_seconds    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (instance_id, beammp_username)
);
CREATE INDEX IF NOT EXISTS idx_known_players_instance_total_seconds
  ON known_players (instance_id, total_seconds DESC);

CREATE TABLE IF NOT EXISTS account_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  beammp_username  TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      TEXT
);

CREATE TABLE IF NOT EXISTS mods (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL DEFAULT 'default',
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('mod', 'vehicle', 'map')),
  filename    TEXT NOT NULL,
  image       TEXT,
  description TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  map_id      TEXT,
  created_at  TEXT NOT NULL,
  is_official INTEGER NOT NULL DEFAULT 0,
  metadata    TEXT,
  UNIQUE (instance_id, filename)
);

-- mod_ids en liste JSON plutôt qu'une table de jointure, sans contrainte :
-- un mod supprimé après la sauvegarde d'une config est juste ignoré à
-- l'application, il ne la bloque jamais (même choix que la v2).
CREATE TABLE IF NOT EXISTS config_presets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL DEFAULT 'default',
  name        TEXT NOT NULL,
  mod_ids     TEXT NOT NULL DEFAULT '[]',
  map_id      TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (instance_id, name)
);

-- Réglages Discord : webhooks par serveur, textes communs (instance_id = '*').
CREATE TABLE IF NOT EXISTS discord_settings (
  instance_id TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (instance_id, key)
);
"""

# Colonnes à décoder à la lecture, par table.
JSON_COLUMNS = {"description", "metadata", "mod_ids"}
BOOL_COLUMNS = {"active", "is_official"}


def now_iso() -> str:
    """Horodatage au format de JavaScript toISOString() (UTC, millisecondes, Z)."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _decode_row(cursor: sqlite3.Cursor, row: tuple) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for (name, *_), value in zip(cursor.description, row):
        if name in JSON_COLUMNS and isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                value = None
        elif name in BOOL_COLUMNS and value is not None:
            value = bool(value)
        out[name] = value
    return out


class Database:
    """Connexion unique protégée par un verrou.

    Le panel a une poignée d'admins : une connexion partagée suffit
    largement, et le verrou rend les appels sûrs depuis les fils de travail
    (analyse de zip, lecture du journal) comme depuis la boucle asyncio.
    """

    def __init__(self, path: str):
        self.path = path
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = _decode_row
        self._lock = threading.RLock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.execute("PRAGMA busy_timeout=5000")

    def migrate(self) -> None:
        with self._lock:
            self._conn.executescript(SCHEMA)
            # Bases créées avant la 3.2.1 : version de jeton (révocation des sessions).
            cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(users)").fetchall()}
            if "token_version" not in cols:
                self._conn.execute("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0")

    def all(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        with self._lock:
            return self._conn.execute(sql, tuple(params)).fetchall()

    def one(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        with self._lock:
            return self._conn.execute(sql, tuple(params)).fetchone()

    def run(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, tuple(params))

    def transaction(self) -> "_Transaction":
        return _Transaction(self)

    def close(self) -> None:
        with self._lock:
            self._conn.close()


class _Transaction:
    def __init__(self, db: Database):
        self.db = db

    def __enter__(self) -> Database:
        self.db._lock.acquire()
        self.db._conn.execute("BEGIN IMMEDIATE")
        return self.db

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            self.db._conn.execute("ROLLBACK" if exc_type else "COMMIT")
        finally:
            self.db._lock.release()


_db: Database | None = None


def init_db(path: str) -> Database:
    global _db
    if _db is not None:
        _db.close()
    _db = Database(path)
    _db.migrate()
    return _db


def db() -> Database:
    if _db is None:
        raise RuntimeError("Base non initialisée (init_db)")
    return _db


def dumps(value: Any) -> str | None:
    return None if value is None else json.dumps(value, ensure_ascii=False)
