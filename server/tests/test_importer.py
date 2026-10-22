"""Import d'un pg_dump de la v2 : types, échappements, ids conservés."""

from __future__ import annotations

import gzip

from beammp_panel.db import db
from beammp_panel.importer import import_rows, iter_dump

DUMP = r"""--
-- PostgreSQL database dump
--
SET statement_timeout = 0;

COPY public.users (id, username, password, role, created_at) FROM stdin;
1	boss	$2b$12$abcdefghijklmnopqrstuuJ2bJ0w8F3nM7N2Qy3m6l8YQGzK1a2b3	superadmin	2025-08-30 12:00:00.123456+00
2	modo	$2b$12$abcdefghijklmnopqrstuuJ2bJ0w8F3nM7N2Qy3m6l8YQGzK1a2b4	moderator	2025-09-01 08:00:00+02
\.

COPY public.known_players (id, instance_id, beammp_username, connection_count, first_seen, last_seen, total_seconds) FROM stdin;
1	default	Zyphro	42	2025-08-30 12:00:00+00	2026-04-11 09:23:36+00	36000
2	default	Tab\tName	1	2025-08-30 12:00:00+00	\N	0
\.

COPY public.account_requests (id, beammp_username, requested_at, status, reviewed_by, reviewed_at) FROM stdin;
1	modo	2025-09-01 07:00:00+00	approved	1	2025-09-01 07:30:00+00
\.

COPY public.mods (id, instance_id, name, type, filename, image, description, active, map_id, created_at, is_official, metadata) FROM stdin;
7	default	Gavril Dynamo	vehicle	1960_Gavril_Dynamo.zip	1960_Gavril_Dynamo.webp	{"fr": "Une \\"belle\\" voiture\\nligne 2"}	t	\N	2025-08-30 12:00:00+00	f	{"kind": "vehicle", "vehicle": {"configCount": 3}}
9	default	Côte Est	map	Cote_Est.zip	\N	\N	f	east_coast_usa	2025-08-30 12:00:00+00	t	\N
\.

COPY public.config_presets (id, instance_id, name, mod_ids, map_id, created_at) FROM stdin;
3	default	Soirée course	{7,9,404}	east_coast_usa	2026-01-01 20:00:00+00
4	default	Vide	{}	\N	2026-01-01 20:00:00+00
\.

COPY public.autre_table (id) FROM stdin;
1
\.
"""


def test_import_pg_dump(tmp_path):
    dump = tmp_path / "beammp.sql.gz"
    with gzip.open(dump, "wt", encoding="utf-8") as f:
        f.write(DUMP)
    counts = import_rows(str(tmp_path / "panel.db"), iter_dump(dump))
    assert counts == {"users": 2, "known_players": 2, "account_requests": 1, "mods": 2, "config_presets": 2}

    boss = db().one("SELECT * FROM users WHERE id = 1")
    assert boss["password"].startswith("$2b$12$") and boss["created_at"] == "2025-08-30T12:00:00.123Z"
    assert db().one("SELECT created_at FROM users WHERE id = 2")["created_at"] == "2025-09-01T06:00:00.000Z"
    assert db().one("SELECT beammp_username FROM known_players WHERE id = 2")["beammp_username"] == "Tab\tName"

    car = db().one("SELECT * FROM mods WHERE id = 7")
    assert car["active"] is True and car["is_official"] is False
    assert car["description"] == {"fr": 'Une "belle" voiture\nligne 2'}
    assert car["metadata"]["vehicle"]["configCount"] == 3
    assert db().one("SELECT is_official FROM mods WHERE id = 9")["is_official"] is True

    presets = {p["name"]: p for p in db().all("SELECT * FROM config_presets")}
    assert presets["Soirée course"]["mod_ids"] == [7, 9, 404] and presets["Vide"]["mod_ids"] == []

    # les nouveaux ids continuent après les ids importés
    cur = db().run("INSERT INTO mods (instance_id, name, type, filename, created_at) VALUES ('default','n','mod','n.zip','x')")
    assert cur.lastrowid == 10


def test_import_refuses_non_empty_db(tmp_path):
    dump = tmp_path / "d.sql"
    dump.write_text(DUMP)
    import_rows(str(tmp_path / "panel.db"), iter_dump(dump))
    try:
        import_rows(str(tmp_path / "panel.db"), iter_dump(dump))
    except SystemExit as err:
        assert "déjà" in str(err)
    else:
        raise AssertionError("un second import aurait dû être refusé")
