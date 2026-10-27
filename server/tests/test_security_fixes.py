"""Non-régression des correctifs de l'audit de sécurité (run-1, octobre 2026)."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import time
import tomllib
from pathlib import Path

import jwt
import pytest
from starlette.testclient import TestClient

from beammp_panel import appmode, logwatch, routes_app
from beammp_panel import config as C
from beammp_panel.db import db

from .conftest import SECRET, login, map_zip
from .test_appmode import fake_server

ROOT = Path(__file__).resolve().parents[2]


def upload_map(client, map_id: str):
    return client.post("/api/i/default/mods/upload", data={"name": "Carte", "type": "map", "map_id": map_id},
                       files={"file": ("carte.zip", map_zip("x"), "application/zip")})


# ── Secrets d'exemple ──────────────────────────────────────────

def test_env_example_secret_refused(env, monkeypatch):
    from beammp_panel.app import check_startup
    example = (ROOT / ".env.example").read_text()
    assert "change-me" not in example and "changeme123" not in example
    for bad in ("change-me-generate-with-openssl-rand-hex-32", "CHANGE-ME-please-0123456789abcdef0123"):
        monkeypatch.setenv("JWT_SECRET", bad)
        C.set_config(C.load_config())
        with pytest.raises(SystemExit):
            check_startup()


def test_default_superadmin_password_refused(client, monkeypatch):
    from beammp_panel.app import create_initial_superadmin
    db().run("DELETE FROM users")
    monkeypatch.setenv("SUPERADMIN_USERNAME", "admin")
    monkeypatch.setenv("SUPERADMIN_PASSWORD", "changeme123")
    create_initial_superadmin()
    assert db().one("SELECT COUNT(*) AS n FROM users")["n"] == 0


# ── Connexion : bcrypt et 72 octets ───────────────────────────

def test_long_password_same_answer_for_known_and_unknown_user(client):
    long_pw = "é" * 50  # 100 octets
    assert client.post("/api/auth/login", json={"username": "boss", "password": long_pw}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "absent", "password": long_pw}).status_code == 401


def test_long_password_can_be_set_and_used(admin):
    long_pw = "x" * 150
    r = admin.patch("/api/auth/password", json={"currentPassword": "motdepasse-boss", "newPassword": long_pw})
    assert r.status_code == 200, r.text
    admin.cookies.clear()
    assert admin.post("/api/auth/login", json={"username": "boss", "password": long_pw}).status_code == 200


# ── Révocation des sessions ───────────────────────────────────

def _token(client) -> str:
    return client.cookies.get("beammp_token")


def test_logout_revokes_copied_token(admin):
    old = _token(admin)
    admin.post("/api/auth/logout")
    admin.cookies.clear()
    assert admin.get("/api/admin/users", headers={"Authorization": f"Bearer {old}"}).status_code == 401


def test_password_change_revokes_other_sessions_but_keeps_current(admin):
    old = _token(admin)
    r = admin.patch("/api/auth/password", json={"currentPassword": "motdepasse-boss", "newPassword": "nouveau-mdp-1"})
    assert r.status_code == 200
    assert admin.get("/api/admin/users").status_code == 200  # le cookie neuf reste valide
    admin.cookies.clear()
    assert admin.get("/api/admin/users", headers={"Authorization": f"Bearer {old}"}).status_code == 401


def test_admin_reset_revokes_target_sessions(admin, client):
    from beammp_panel.security import hash_password
    db().run("INSERT INTO users (username, password, role, created_at) VALUES ('modo', ?, 'admin', 'x')",
             [hash_password("motdepasse-modo")])
    uid = db().one("SELECT id FROM users WHERE username = 'modo'")["id"]
    other = TestClient(client.app)
    login(other, "modo", "motdepasse-modo")
    old = _token(other)
    assert admin.patch(f"/api/admin/users/{uid}/password", json={"password": "reinit-123"}).status_code == 200
    fresh = TestClient(client.app)
    assert fresh.get("/api/i/default/logs", headers={"Authorization": f"Bearer {old}"}).status_code == 401


def test_token_without_version_still_valid(client):
    """Jetons émis par la 3.2.0 ou la v2 (sans « tv ») : valides tant que rien n'a été révoqué."""
    now = int(time.time())
    tok = jwt.encode({"id": 1, "username": "boss", "role": "superadmin", "iat": now, "exp": now + 60}, SECRET, algorithm="HS256")
    assert client.get("/api/admin/users", headers={"Authorization": f"Bearer {tok}"}).status_code == 200


def test_last_superadmin_cannot_be_demoted(admin):
    me = db().one("SELECT id FROM users WHERE username = 'boss'")["id"]
    assert admin.patch(f"/api/admin/users/{me}/role", json={"role": "admin"}).status_code == 409


def test_password_change_is_rate_limited(admin):
    codes = [admin.patch("/api/auth/password", json={"currentPassword": "faux", "newPassword": "nouveau-mdp-1"}).status_code
             for _ in range(7)]
    assert 429 in codes


# ── ServerConfig.toml ─────────────────────────────────────────

def test_map_id_with_quote_or_newline_refused(admin, env):
    r = upload_map(admin, 'x"\nAllowGuests = true\n#')
    assert r.status_code == 400
    assert admin.post("/api/i/default/maps/activate", json={"map_id": 'x"\nAllowGuests = true\n#'}).status_code == 404
    assert "AllowGuests" not in (env / "ServerConfig.toml").read_text()


def test_valid_map_still_activates(admin, env):
    assert upload_map(admin, "west_coast_usa").status_code == 200
    assert admin.post("/api/i/default/maps/activate", json={"map_id": "west_coast_usa"}).status_code == 200
    cfg = tomllib.loads((env / "ServerConfig.toml").read_text())
    assert cfg["General"]["Map"] == "/levels/west_coast_usa/info.json"


def test_patch_config_strips_control_characters(admin, env):
    assert admin.patch("/api/i/default/config", json={"Name": "a\x0bb\x00c", "MaxPlayers": "-5"}).status_code == 200
    cfg = tomllib.loads((env / "ServerConfig.toml").read_text())
    assert cfg["General"]["Name"] == "abc" and cfg["General"]["MaxPlayers"] == 0


# ── Corps JSON ────────────────────────────────────────────────

def test_json_body_requires_json_content_type(client):
    r = client.post("/api/auth/login", content=json.dumps({"username": "boss", "password": "motdepasse-boss"}),
                    headers={"Content-Type": "text/plain"})
    assert r.status_code == 415


def test_json_body_size_capped(client):
    big = json.dumps({"username": "boss", "password": "x" * (2 * 1024 * 1024)})
    r = client.post("/api/auth/login", content=big, headers={"Content-Type": "application/json"})
    assert r.status_code == 413


# ── Journal du jeu ────────────────────────────────────────────

def test_unprefixed_log_line_is_not_a_join(client):
    inst = C.config.instances[0]
    asyncio.run(logwatch.process_line(inst, "Admin : Connected"))
    asyncio.run(logwatch.process_line(inst, "[22/10/26 20:00:00] [INFO] " + "N" * 500 + " : Connected"))
    assert db().one("SELECT COUNT(*) AS n FROM known_players")["n"] == 0
    asyncio.run(logwatch.process_line(inst, "[22/10/26 20:00:00] [INFO] Zyphro : Connected"))
    assert db().one("SELECT beammp_username FROM known_players")["beammp_username"] == "Zyphro"


def test_discord_escape():
    from beammp_panel.discord import md_escape
    assert md_escape("x](http://e) @everyone") == "x\\]\\(http://e\\) \\@everyone"


# ── Assistant de premier lancement ────────────────────────────

@pytest.fixture()
def setup_env(tmp_path, monkeypatch):
    for key in list(os.environ):
        if key.startswith(("BEAMMP_", "SUPERADMIN_", "INSTANCE")) or key in ("JWT_SECRET", "DATA_DIR", "HOST", "PORT"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("BEAMMP_PANEL_APP", "1")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(routes_app, "LOCAL_HOSTS", routes_app.LOCAL_HOSTS | {"testclient"})
    appmode.apply_to_environ()
    C.set_config(C.load_config())
    return tmp_path


def _setup_body(server_dir):
    return {"serverDir": str(server_dir), "username": "zyphro", "password": "motdepasse", "authKey": "cle-123"}


def test_setup_refuses_foreign_host_origin_and_text_plain(setup_env):
    from beammp_panel.app import create_app
    server_dir = setup_env / "BeamMP-Server"
    fake_server(server_dir)
    app = create_app(start_watchers=False, frontend_dir="")
    with TestClient(app, base_url="http://attacker.example.com") as c:  # rebinding DNS
        assert c.post("/api/setup", json=_setup_body(server_dir)).status_code == 403
    with TestClient(app, base_url="http://127.0.0.1:3000") as c:
        assert c.post("/api/setup", json=_setup_body(server_dir), headers={"Origin": "https://evil.example"}).status_code == 403
        r = c.post("/api/setup", content=json.dumps(_setup_body(server_dir)), headers={"Content-Type": "text/plain"})
        assert r.status_code == 415
        assert c.post("/api/setup", json={**_setup_body(server_dir), "serverDir": "//host/share/srv"}).status_code == 400
        assert db().one("SELECT COUNT(*) AS n FROM users")["n"] == 0
        ok = c.post("/api/setup", json=_setup_body(server_dir), headers={"Origin": "http://127.0.0.1:3000"})
        assert ok.status_code == 200, ok.text


def test_setup_requires_superadmin_once_an_account_exists(setup_env, monkeypatch):
    from beammp_panel.app import create_app
    from beammp_panel.security import hash_password
    server_dir = setup_env / "BeamMP-Server"
    fake_server(server_dir)
    with TestClient(create_app(start_watchers=False, frontend_dir=""), base_url="http://127.0.0.1:3000") as c:
        db().run("INSERT INTO users (username, password, role, created_at) VALUES ('boss', ?, 'superadmin', 'x')",
                 [hash_password("motdepasse-boss")])
        assert c.get("/api/setup").json()["needed"] is True  # dossier du serveur pas encore choisi
        assert c.post("/api/setup", json=_setup_body(server_dir)).status_code == 401
        login(c, "boss", "motdepasse-boss")
        assert c.post("/api/setup", json=_setup_body(server_dir)).status_code == 200


# ── Agent hôte ────────────────────────────────────────────────

def _agent():
    os.environ.setdefault("RESTART_TOKEN", "jeton-de-test")
    spec = importlib.util.spec_from_file_location("beammp_agent", ROOT / "agent" / "beammp-agent.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_agent_accepts_only_parsed_official_assets():
    agent = _agent()
    prefix = "https://github.com/BeamMP/BeamMP-Server/releases/download/"
    assert agent.official_asset(prefix + "v3.9.4/BeamMP-Server.ubuntu.22.04.x86_64") == ("v3.9.4", "BeamMP-Server.ubuntu.22.04.x86_64")
    for bad in (prefix + "../../../../evil/repo/releases/download/v1/x", prefix + "%2e%2e/a/b",
                "https://github.com@evil.example/BeamMP/BeamMP-Server/releases/download/v1/x",
                "http://github.com/BeamMP/BeamMP-Server/releases/download/v1/x", prefix + "v1/x?y=1", prefix + "v1/a/b"):
        assert agent.official_asset(bad) is None, bad
    assert agent._allowed_redirect("https://release-assets.githubusercontent.com/x")
    assert not agent._allowed_redirect("https://evil.example/x")
