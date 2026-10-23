"""Contrat de l'API : mêmes routes, mêmes formes de réponse que la v2."""

from __future__ import annotations

import asyncio
import json
import struct
from pathlib import Path

import jwt
import pytest

from beammp_panel import config as C
from beammp_panel import logwatch, status
from beammp_panel.db import db
from beammp_panel.security import hash_password

from .conftest import SECRET, login, map_zip, png_bytes, vehicle_zip


def upload(client, data: bytes, filename: str, name: str, type_: str, **extra):
    fields = {"name": name, "type": type_, **extra}
    return client.post("/api/i/default/mods/upload", data=fields,
                       files={"file": (filename, data, "application/zip")})


# ── Public ─────────────────────────────────────────────────────

def test_public_routes(client):
    assert client.get("/api/instances").json() == [{"id": "default", "name": "BeamMP Server", "canRestart": False}]
    st = client.get("/api/i/default/status").json()
    assert set(st) >= {"online", "playerCount", "maxPlayers", "players", "map", "mapName", "serverName", "uptimeMs"}
    assert st["maxPlayers"] == 8 and st["serverName"] == "Serveur test"
    assert client.get("/api/i/nope/status").json()["online"] is False
    assert client.get("/api/info").json() == {"discordUrl": "", "kofiUrl": "", "serverDescription": ""}
    assert client.get("/api/i/default/mods/active").json() == []
    assert client.get("/api/activity").json() == []


def test_public_catalog(admin, env):
    upload(admin, map_zip("black_hills"), "hills.zip", "Hills", "map", map_id="black_hills")
    upload(admin, map_zip("italy"), "italy.zip", "Italie", "map", map_id="italy")
    upload(admin, vehicle_zip(), "car.zip", "Car", "vehicle")
    admin.cookies.clear()  # page publique : sans session
    cat = admin.get("/api/i/default/catalog").json()
    assert [(m["type"], m["name"], m["active"]) for m in cat] == [
        ("map", "Hills", True), ("map", "Italie", False), ("vehicle", "Car", True)]
    assert all("filename" not in m for m in cat)
    assert cat[2]["metadata"]["vehicle"]["brand"] == "Gavril"


def test_security_headers_and_version(client):
    r = client.get("/api/instances")
    assert r.headers["x-beammp-panel-version"].startswith("3.")
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-frame-options"] == "SAMEORIGIN"


def test_unknown_api_is_json_404(client):
    r = client.get("/api/does-not-exist")
    assert r.status_code == 404 and r.json() == {"error": "Not found"}


# ── Authentification ───────────────────────────────────────────

def test_login_cookie_and_v2_token_compat(client):
    r = client.post("/api/auth/login", json={"username": "boss", "password": "motdepasse-boss"})
    assert r.status_code == 200
    assert r.json()["user"]["role"] == "superadmin"
    cookie = r.cookies.get("beammp_token")
    payload = jwt.decode(cookie, SECRET, algorithms=["HS256"])
    assert payload["username"] == "boss" and payload["exp"] - payload["iat"] == 7 * 86400
    assert "httponly" in r.headers["set-cookie"].lower() and "samesite=strict" in r.headers["set-cookie"].lower()


def test_login_failures_and_rate_limit(client):
    assert client.post("/api/auth/login", json={"username": "boss", "password": "faux"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "inconnu", "password": "x"}).json() == \
        {"error": "Identifiants invalides"}
    assert client.post("/api/auth/login", json={"username": "", "password": "x"}).status_code == 400
    codes = [client.post("/api/auth/login", json={"username": "boss", "password": "faux"}).status_code for _ in range(5)]
    assert codes[-1] == 429


def test_legacy_scrypt_hash_is_migrated(client):
    import hashlib
    legacy = hashlib.scrypt(b"ancienmdp", salt=b"beammp-salt", n=16384, r=8, p=1, dklen=64).hex()
    db().run("INSERT INTO users (username, password, role, created_at) VALUES ('vieux', ?, 'admin', 'x')", [legacy])
    login(client, "vieux", "ancienmdp")
    assert db().one("SELECT password FROM users WHERE username = 'vieux'")["password"].startswith("$2b$")


def test_roles(client):
    db().run("INSERT INTO users (username, password, role, created_at) VALUES ('modo', ?, 'moderator', 'x')",
             [hash_password("motdepasse-modo")])
    login(client, "modo", "motdepasse-modo")
    assert client.get("/api/i/default/mods").status_code == 200
    assert client.get("/api/i/default/logs").status_code == 403
    assert client.patch("/api/i/default/config", json={"Name": "x"}).status_code == 403
    assert client.get("/api/admin/users").status_code == 403
    client.cookies.clear()
    assert client.get("/api/i/default/mods").status_code == 401


def test_role_change_applies_immediately(admin):
    db().run("UPDATE users SET role = 'moderator' WHERE username = 'boss'")
    assert admin.get("/api/admin/users").status_code == 403


def test_change_password(admin):
    assert admin.patch("/api/auth/password", json={"currentPassword": "faux", "newPassword": "nouveau-mdp"}).status_code == 401
    assert admin.patch("/api/auth/password", json={"currentPassword": "motdepasse-boss", "newPassword": "court"}).status_code == 400
    assert admin.patch("/api/auth/password", json={"currentPassword": "motdepasse-boss", "newPassword": "nouveau-mdp"}).json() == {"ok": True}
    admin.cookies.clear()
    login(admin, "boss", "nouveau-mdp")


# ── Demandes de compte et utilisateurs ─────────────────────────

def test_account_request_flow(admin):
    assert admin.post("/api/auth/request-account", json={"beammp_username": "Zed"}).status_code == 400
    db().run("INSERT INTO known_players (instance_id, beammp_username, connection_count, first_seen) VALUES ('default', 'Zed', 3, 'x')")
    assert "Demande envoyée" in admin.post("/api/auth/request-account", json={"beammp_username": "Zed"}).json()["message"]
    assert admin.post("/api/auth/request-account", json={"beammp_username": "Zed"}).status_code == 409
    reqs = admin.get("/api/admin/requests").json()
    assert len(reqs) == 1 and reqs[0]["connection_count"] == 3
    rid = reqs[0]["id"]
    assert admin.post(f"/api/admin/requests/{rid}", json={"action": "approve", "password": "court"}).status_code == 400
    assert admin.post(f"/api/admin/requests/{rid}", json={"action": "approve", "password": "motdepasse-zed"}).json() == {"approved": "Zed"}
    assert admin.post(f"/api/admin/requests/{rid}", json={"action": "reject"}).status_code == 409
    users = admin.get("/api/admin/users").json()
    zed = next(u for u in users if u["username"] == "Zed")
    assert zed["role"] == "moderator" and set(zed) == {"id", "username", "role", "created_at"}
    assert admin.patch(f"/api/admin/users/{zed['id']}/role", json={"role": "admin"}).json()["role"] == "admin"
    assert admin.patch(f"/api/admin/users/{zed['id']}/role", json={"role": "roi"}).status_code == 400
    assert admin.patch(f"/api/admin/users/{zed['id']}/password", json={"password": "encore-un-mdp"}).status_code == 200
    me = next(u for u in users if u["username"] == "boss")
    assert admin.delete(f"/api/admin/users/{me['id']}").status_code == 400
    assert admin.delete(f"/api/admin/users/{zed['id']}").json() == {"deleted": True}


# ── Mods ───────────────────────────────────────────────────────

def test_upload_vehicle_and_metadata(admin, env):
    r = upload(admin, vehicle_zip(), "Gavril Dynamo.zip", "Dynamo", "vehicle", description="Une voiture")
    assert r.status_code == 200, r.text
    mod = r.json()
    assert mod["filename"] == "Gavril_Dynamo.zip" and mod["active"] is True and mod["is_official"] is False
    assert mod["description"] == {"fr": "Une voiture"}
    v = mod["metadata"]["vehicle"]
    assert v["brand"] == "Gavril" and v["yearMin"] == 1960
    # la config livrée seulement en .pc est comptée, le SJSON sans virgules est lu
    assert v["configCount"] == 2 and "Sport (M)" in v["configurations"] and "race" in v["configurations"]
    assert v["drivetrains"] == ["RWD"] and v["powerMin"] == 180
    assert mod["image"] == "default_Gavril_Dynamo.webp"
    assert (Path(C.config.images_path) / mod["image"]).is_file()
    assert (env / "res" / "Client" / "Gavril_Dynamo.zip").is_file()
    assert upload(admin, vehicle_zip(), "Gavril Dynamo.zip", "Dynamo", "vehicle").status_code == 409


def test_upload_rejects_bad_files(admin):
    assert upload(admin, b"not a zip at all", "x.zip", "X", "mod").status_code == 400
    assert upload(admin, vehicle_zip(), "x.exe", "X", "mod").status_code == 400
    assert upload(admin, vehicle_zip(), "x.zip", "", "mod").status_code == 400


def test_toggle_delete_official_description_image(admin, env):
    mod = upload(admin, vehicle_zip(), "car.zip", "Car", "vehicle").json()
    off = admin.post(f"/api/i/default/mods/{mod['id']}/toggle").json()
    assert off["active"] is False and off["needsRestart"] is True
    assert (env / "res" / "inactive_mod" / "car.zip").is_file()
    assert admin.post(f"/api/i/default/mods/{mod['id']}/toggle").json()["active"] is True
    assert (env / "res" / "Client" / "car.zip").is_file()

    d = admin.patch(f"/api/i/default/mods/{mod['id']}/description", json={"lang": "en", "text": "A car"}).json()
    assert d["description"] == {"en": "A car"}
    d = admin.patch(f"/api/i/default/mods/{mod['id']}/description", json={"lang": "en", "text": ""}).json()
    assert d["description"] == {}
    assert admin.patch(f"/api/i/default/mods/{mod['id']}/description", json={"lang": "FR!", "text": "x"}).status_code == 400

    img = admin.post(f"/api/i/default/mods/{mod['id']}/image", files={"file": ("a.png", png_bytes(), "image/png")})
    assert img.json() == {"image": f"{mod['id']}.webp"}
    assert not (Path(C.config.images_path) / "default_car.webp").exists()  # ancienne image retirée
    assert admin.post(f"/api/i/default/mods/{mod['id']}/image", files={"file": ("a.png", b"zz", "image/png")}).status_code == 400

    assert admin.patch(f"/api/i/default/mods/{mod['id']}/official").json()["is_official"] is True
    assert admin.delete(f"/api/i/default/mods/{mod['id']}").status_code == 403
    admin.patch(f"/api/i/default/mods/{mod['id']}/official")
    assert admin.delete(f"/api/i/default/mods/{mod['id']}").json() == {"deleted": True}
    assert not (env / "res" / "Client" / "car.zip").exists()
    assert admin.delete("/api/i/default/mods/9999").status_code == 404


def test_maps_activation_and_inactive_upload(admin, env):
    m1 = upload(admin, map_zip("black_hills"), "hills.zip", "Hills", "map", map_id="black_hills").json()
    m2 = upload(admin, map_zip("italy"), "italy.zip", "Italie", "map", map_id="/levels/italy/info.json").json()
    assert m1["active"] is True and m2["active"] is False
    # une carte qui arrive inactive ne part plus dans Client/
    assert (env / "res" / "inactive_map" / "italy.zip").is_file()
    assert admin.post(f"/api/i/default/mods/{m1['id']}/toggle").status_code == 400

    r = admin.post("/api/i/default/maps/activate", json={"map_id": "/levels/italy/info.json"})
    assert r.json() == {"activated": "/levels/italy/info.json", "needsRestart": True}
    cfg = (env / "ServerConfig.toml").read_text()
    assert 'Map = "/levels/italy/info.json"' in cfg  # pas de chemin doublé
    assert (env / "res" / "Client" / "italy.zip").is_file()
    assert (env / "res" / "inactive_map" / "hills.zip").is_file()
    assert admin.post("/api/i/default/maps/activate", json={"map_id": "nope"}).status_code == 404
    active = admin.get("/api/i/default/mods/active").json()
    assert [m["name"] for m in active] == ["Italie"]


# ── Config, journaux, alertes ──────────────────────────────────

def test_config_whitelist_and_types(admin, env):
    cfg = admin.get("/api/i/default/config").json()
    assert "AuthKey" not in cfg and cfg["Name"] == "Serveur test" and cfg["Private"] == "true"
    assert admin.patch("/api/i/default/config", json={"AuthKey": "x"}).status_code == 400
    assert admin.patch("/api/i/default/config",
                       json={"Private": "false", "MaxPlayers": "12", "Name": 'Le "Zyphro"\nAuthKey = "pwn"',
                             "Tags": "Freeroam"}).json() == {"updated": True}
    toml = (env / "ServerConfig.toml").read_text()
    assert "Private = false" in toml and "MaxPlayers = 12" in toml
    assert 'Name = "Le \\"Zyphro\\"AuthKey = \\"pwn\\""' in toml
    assert toml.count("AuthKey") == 2  # la vraie clé + le texte échappé, aucune nouvelle ligne
    general = toml.split("[Misc]")[0]
    assert 'Tags = "Freeroam"' in general  # clé absente ajoutée dans [General], pas en fin de fichier


def test_logs_tail_and_alerts(admin, env):
    log = env / "logs" / "Server.log"
    log.write_text("".join(f"[22/10/26 10:00:{i % 60:02d}] [INFO] ligne {i}\n" for i in range(300)))
    lines = admin.get("/api/i/default/logs?lines=5").json()["lines"]
    assert lines == [f"[22/10/26 10:00:{i % 60:02d}] [INFO] ligne {i}" for i in range(295, 300)]
    assert len(admin.get("/api/i/default/logs?lines=abc").json()["lines"]) == 100
    assert admin.get("/api/i/default/alerts").json() == []


def test_server_routes_without_agent(admin):
    assert admin.post("/api/i/default/server/restart").status_code == 501
    assert admin.get("/api/i/default/server/update-check").json()["enabled"] is False
    assert admin.post("/api/i/default/server/update").status_code == 501


# ── Presets ────────────────────────────────────────────────────

def test_presets(admin, env):
    car = upload(admin, vehicle_zip(), "car.zip", "Car", "vehicle").json()
    other = upload(admin, vehicle_zip(), "other.zip", "Other", "vehicle").json()
    upload(admin, map_zip("black_hills"), "hills.zip", "Hills", "map", map_id="black_hills")
    upload(admin, map_zip("italy"), "italy.zip", "Italie", "map", map_id="italy")
    p = admin.post("/api/i/default/presets", json={"name": "Course", "mod_ids": [car["id"], 999], "map_id": "italy"}).json()
    assert p["mod_ids"] == [car["id"], 999]
    assert admin.post("/api/i/default/presets", json={"name": "Course", "mod_ids": []}).status_code == 409
    assert admin.post("/api/i/default/presets", json={"name": "X", "mod_ids": ["a"]}).status_code == 400
    r = admin.post(f"/api/i/default/presets/{p['id']}/apply").json()
    assert r["modsActivated"] == 1 and r["modsMissing"] == 1 and r["mapApplied"] == "Italie"
    assert r["needsRestart"] is True and r["restarted"] is False
    mods = {m["name"]: m for m in admin.get("/api/i/default/mods").json()}
    assert mods["Car"]["active"] and not mods["Other"]["active"] and mods["Italie"]["active"]
    upd = admin.put(f"/api/i/default/presets/{p['id']}", json={"name": "Course 2", "mod_ids": [other["id"]], "map_id": None}).json()
    assert upd["name"] == "Course 2" and upd["map_id"] is None
    assert [x["name"] for x in admin.get("/api/i/default/presets").json()] == ["Course 2"]
    assert admin.delete(f"/api/i/default/presets/{p['id']}").json() == {"deleted": True}


# ── Cohérence et scan-import ───────────────────────────────────

def test_scan_import_and_consistency(admin, env):
    (env / "res" / "Client" / "loose_car.zip").write_bytes(vehicle_zip())
    (env / "res" / "inactive_map").mkdir()
    (env / "res" / "inactive_map" / "loose_map.zip").write_bytes(map_zip())
    rep = admin.post("/api/admin/i/default/scan-import").json()
    assert rep["imported"] == 2 and rep["errors"] == 0
    by = {r["filename"]: r for r in rep["results"]}
    assert by["loose_car.zip"]["type"] == "vehicle" and by["loose_car.zip"]["name"] == "Gavril Dynamo"
    assert by["loose_map.zip"]["type"] == "map" and by["loose_map.zip"]["active"] is False
    assert admin.post("/api/admin/i/default/scan-import").json()["skipped"] == 2

    # désordre volontaire : fichier déplacé à la main, orphelins
    (env / "res" / "inactive_mod").mkdir(exist_ok=True)
    (env / "res" / "Client" / "loose_car.zip").rename(env / "res" / "inactive_mod" / "loose_car.zip")
    (env / "res" / "Client" / "orphan.zip").write_bytes(b"PK\x03\x04")
    (Path(C.config.images_path) / "orphan.webp").write_bytes(b"x")
    report = admin.get("/api/admin/i/default/consistency").json()
    types = sorted(i["type"] for i in report["issues"])
    assert types == ["orphan_file", "orphan_image", "wrong_location"]
    assert report["summary"]["total"] == 3
    for issue in report["issues"]:
        r = admin.post("/api/admin/i/default/consistency/fix", json={"fix": issue["fix"], "meta": issue["meta"]})
        assert r.json()["fixed"] is True, r.text
    assert admin.get("/api/admin/i/default/consistency").json()["issues"] == []
    bad = admin.post("/api/admin/i/default/consistency/fix",
                     json={"fix": "delete_orphan_file", "meta": {"filename": "../ServerConfig.toml", "location": "client"}})
    assert bad.status_code == 400 and (env / "ServerConfig.toml").exists()


def test_analyze_existing(admin, env):
    (env / "res" / "Client" / "car.zip").write_bytes(vehicle_zip())
    db().run("INSERT INTO mods (instance_id, name, type, filename, active, created_at) VALUES ('default','c','vehicle','car.zip',1,'x')")
    db().run("INSERT INTO mods (instance_id, name, type, filename, active, created_at) VALUES ('default','g','mod','gone.zip',1,'x')")
    r = admin.post("/api/admin/i/default/mods/analyze-existing").json()
    assert r == {"analyzed": 1, "notFound": 1, "errors": 0, "total": 2, "remaining": False}


# ── Journal du serveur ─────────────────────────────────────────

def test_logwatch_real_beammp_lines(admin, env):
    inst = C.config.instances[0]

    async def feed():
        for line in ["[22/10/26 06:28:15] [INFO] ALL SYSTEMS STARTED SUCCESSFULLY, EVERYTHING IS OKAY",
                     "[22/10/26 20:00:00] [INFO] Zyphro : Connected",
                     "[22/10/26 20:00:01] [CHAT] (0) <Zyphro>  Bob : Connected",
                     "[22/10/26 20:05:00] [INFO] Inconnu Connection Terminated",
                     '[22/10/26 20:06:00] [ERROR] Backend REFUSED the auth key. Reason: invalid']:
            await logwatch.process_line(inst, line)
    asyncio.run(feed())
    assert status.online_players("default") == ["Zyphro"]
    kp = admin.get("/api/admin/players?instanceId=default").json()
    assert [p["beammp_username"] for p in kp] == ["Zyphro"] and kp[0]["connection_count"] == 1
    act = admin.get("/api/i/default/activity").json()
    assert [a["type"] for a in act] == ["player_join"]  # ni le chat ni la connexion refusée
    alerts = admin.get("/api/i/default/alerts").json()
    assert alerts[0]["type"] == "auth_key_invalid"
    assert logwatch.server_started_at("default") is not None
    asyncio.run(logwatch.process_line(inst, "[22/10/26 20:10:00] [INFO] Zyphro Connection Terminated"))
    assert status.online_players("default") == []
    assert admin.get("/api/i/default/activity").json()[0]["type"] == "player_leave"


# ── Statut par le paquet I ─────────────────────────────────────

def test_info_packet_status(client, env):
    info = {"players": "2", "maxplayers": "14", "map": "/levels/x/info.json", "name": "Zyphro", "version": "3.9.4",
            "playerslist": "Alice;Bob;", "modlist": "/a.zip;/b.zip;", "modstotalsize": "123", "desc": "Salut^pmonde"}

    async def run():
        async def handle(reader, writer):
            assert await reader.readexactly(1) == b"I"
            body = json.dumps(info).encode()
            writer.write(struct.pack("<i", len(body)) + body)
            await writer.drain()
            writer.close()
        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        inst = C.config.instances[0]
        inst.beammp.info_host, inst.server_port = "127.0.0.1", str(port)
        async with server:
            return await status.get_server_status(inst)

    st = asyncio.run(run())
    assert st["online"] is True and st["players"] == ["Alice", "Bob"] and st["playerCount"] == 2
    assert st["maxPlayers"] == 14 and st["modlist"] == ["a.zip", "b.zip"] and st["sdesc"] == "Salut\nmonde"
    assert st["source"] == "local" and st["modsTotalSize"] == 123


@pytest.mark.parametrize("map_id,expected", [
    ("italy", "/levels/italy/info.json"),
    ("/levels/italy/info.json", "/levels/italy/info.json"),
    ("levels/Utah/", "/levels/Utah/info.json"),
])
def test_map_config_value(map_id, expected):
    from beammp_panel.modstate import map_config_value
    assert map_config_value(map_id) == expected
