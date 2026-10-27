"""Mode appli : assistant de premier lancement, supervision du serveur, mise à jour signée."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import stat
import sys
import zipfile
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from starlette.testclient import TestClient

from beammp_panel import appmode, routes_app, supervisor, updater
from beammp_panel import config as C
from beammp_panel.config import BeamMPPaths, InstanceConfig


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


# ── Assistant de premier lancement ─────────────────────────────

@pytest.fixture()
def app_env(tmp_path, monkeypatch):
    for key in list(os.environ):
        if key.startswith(("BEAMMP_", "SUPERADMIN_", "INSTANCE")) or key in ("JWT_SECRET", "DATA_DIR", "HOST", "PORT"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("BEAMMP_PANEL_APP", "1")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(routes_app, "LOCAL_HOSTS", routes_app.LOCAL_HOSTS | {"testclient"})
    appmode.apply_to_environ()
    C.set_config(C.load_config())
    return tmp_path


def fake_server(directory: Path) -> Path:
    """Un « BeamMP-Server » factice : écrit Server.log puis attend, comme le vrai."""
    directory.mkdir(parents=True, exist_ok=True)
    exe = directory / ("BeamMP-Server.exe" if sys.platform == "win32" else "BeamMP-Server")
    exe.write_text(
        f"#!{sys.executable}\n"
        "import sys, time\n"
        "if '--version' in sys.argv: print('BeamMP-Server v3.9.4'); sys.exit(0)\n"
        "open('Server.log', 'a').write('[23/10/26 10:00:00] [INFO] ALL SYSTEMS STARTED SUCCESSFULLY, EVERYTHING IS OKAY\\n')\n"
        "time.sleep(600)\n")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return exe


def test_settings_generate_secret_and_paths(app_env):
    s = appmode.load_settings()
    assert len(s["jwt_secret"]) == 64
    assert os.environ["HOST"] == "127.0.0.1"
    paths = appmode.server_paths("/srv/beammp")
    assert paths["BEAMMP_LOG_PATH"] == "/srv/beammp/Server.log"
    assert paths["BEAMMP_RESOURCES_PATH"] == "/srv/beammp/Resources"


def test_setup_wizard(app_env):
    from beammp_panel.app import create_app
    server_dir = app_env / "BeamMP-Server"
    fake_server(server_dir)
    # L'assistant n'accepte que l'hôte local (en-tête Host compris).
    with TestClient(create_app(start_watchers=False, frontend_dir=""), base_url="http://127.0.0.1:3000") as client:
        st = client.get("/api/setup").json()
        assert st["appMode"] and st["needed"] and not st["hasAdmin"]
        assert client.post("/api/setup", json={"serverDir": "relatif", "username": "a", "password": "motdepasse"}).status_code == 400
        assert client.post("/api/setup", json={"serverDir": str(app_env / "vide"), "username": "a",
                                               "password": "motdepasse"}).status_code == 400
        no_key = client.post("/api/setup", json={"serverDir": str(server_dir), "username": "a", "password": "motdepasse"})
        assert no_key.status_code == 400 and "obligatoire" in no_key.json()["error"]
        r = client.post("/api/setup", json={"serverDir": str(server_dir), "username": "zyphro", "password": "motdepasse",
                                            "serverName": "Mon serveur", "authKey": "cle-123"})
        assert r.json() == {"configured": True}, r.text
        assert client.get("/api/setup").json()["needed"] is False
        assert client.post("/api/setup", json={}).status_code == 409
        toml = (server_dir / "ServerConfig.toml").read_text()
        assert 'Name = "Mon serveur"' in toml and 'AuthKey = "cle-123"' in toml
        assert C.config.instances[0].beammp.log_path == str(server_dir / "Server.log")
        assert client.get("/api/instances").json()[0]["canRestart"] is True
        login = client.post("/api/auth/login", json={"username": "zyphro", "password": "motdepasse"})
        assert login.json()["user"]["role"] == "superadmin"


def test_setup_refused_from_network(app_env, monkeypatch):
    from beammp_panel.app import create_app
    monkeypatch.setattr(routes_app, "LOCAL_HOSTS", {"127.0.0.1"})
    with TestClient(create_app(start_watchers=False, frontend_dir="")) as client:
        assert client.post("/api/setup", json={"serverDir": "/x"}).status_code == 403


# ── Supervision ────────────────────────────────────────────────

@pytest.mark.skipif(sys.platform == "win32", reason="exécutable factice en script shebang")
def test_supervisor_start_restart_crash_stop(tmp_path):
    exe = fake_server(tmp_path / "srv")
    inst = InstanceConfig(id="t", name="t", server_ip="", server_port="",
                          beammp=BeamMPPaths("", 0, "", "", "", ""), agent=None, server_exe=str(exe))

    async def run():
        sp = supervisor.get(inst)
        await sp.start()
        first = sp.proc.pid
        assert sp.running() and (await sp.version()) == "BeamMP-Server v3.9.4"
        await sp.restart()
        assert sp.running() and sp.proc.pid != first
        sp.proc.kill()                      # plantage
        sp.proc.wait()
        for _ in range(20):
            await asyncio.sleep(0.5)
            if sp.running():
                break
        assert sp.running(), "le serveur aurait dû être relancé"
        await sp.stop()
        assert not sp.running() and not sp.wanted
        await supervisor.stop_all()
    asyncio.run(run())
    assert "ALL SYSTEMS STARTED" in (tmp_path / "srv" / "Server.log").read_text()


def test_supervisor_install_rejects_foreign_url_and_bad_hash(tmp_path):
    inst = InstanceConfig(id="u", name="u", server_ip="", server_port="",
                          beammp=BeamMPPaths("", 0, "", "", "", ""), agent=None,
                          server_exe=str(tmp_path / "BeamMP-Server"))
    sp = supervisor.ServerProcess(inst)
    with pytest.raises(ValueError):
        asyncio.run(sp.install("https://evil.example/BeamMP-Server.exe", "00"))


# ── Mise à jour signée ─────────────────────────────────────────

def test_manifest_signature():
    key = Ed25519PrivateKey.generate()
    pub = b64(key.public_key().public_bytes_raw())
    body = json.dumps({"app": "beammp-panel", "version": "9.9.9", "channel": "stable"}).encode()
    sig = b64(key.sign(body))
    assert updater.verify_manifest(body, sig, pub)["version"] == "9.9.9"
    with pytest.raises(ValueError):
        updater.verify_manifest(body.replace(b"9.9.9", b"9.9.8"), sig, pub)
    other = json.dumps({"app": "zcoach", "version": "1.0.0"}).encode()
    with pytest.raises(ValueError):
        updater.verify_manifest(other, b64(key.sign(other)), pub)
    assert updater.newer("3.2.0", "3.1.0") and not updater.newer("3.1.0-beta.1", "3.1.0")


def test_extract_code_refuses_path_traversal(tmp_path):
    good = io.BytesIO()
    with zipfile.ZipFile(good, "w") as zf:
        zf.writestr("beammp_panel/__init__.py", 'VERSION = "9.9.9"\n')
    updater.extract_code(good.getvalue(), tmp_path / "app.new")
    assert (tmp_path / "app.new" / "beammp_panel" / "__init__.py").is_file()
    bad = io.BytesIO()
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("../evil.txt", "x")
        zf.writestr("beammp_panel/__init__.py", "")
    with pytest.raises(ValueError):
        updater.extract_code(bad.getvalue(), tmp_path / "app.new2")
    assert not (tmp_path / "evil.txt").exists()
    assert hashlib.sha256(good.getvalue()).hexdigest()
