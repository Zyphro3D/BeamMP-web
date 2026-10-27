"""Mise à jour depuis le panel en Docker (install.sh) : demande déposée pour l'hôte, avancement."""

from __future__ import annotations

import base64
import json
import re
import subprocess
import time
from pathlib import Path

import pytest

from beammp_panel import VERSION, updater

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def host_dir(tmp_path, monkeypatch):
    d = tmp_path / "update"
    d.mkdir()
    (d / "agent.json").write_text('{"agent": "systemd"}')
    monkeypatch.setattr(updater, "UPDATE_DIR", d)
    monkeypatch.setattr(updater, "PUBLIC_KEY_B64", "cle-de-test")
    yield d
    updater.STATE.update(phase="idle", manifest=None, error="")


def _available(version="9.9.9", docker=True):
    m = {"app": "beammp-panel", "version": version, "channel": "stable"}
    if docker:
        m["docker"] = {"name": f"beammp-panel-docker-{version}.zip", "size": 1, "sha256": "0" * 64}
    updater.STATE.update(phase="available", version=version, manifest=m)


def test_docker_mode_needs_the_host_agent(host_dir):
    assert updater.docker_mode() and updater.enabled()
    (host_dir / "agent.json").unlink()
    assert not updater.docker_mode() and not updater.enabled()


def test_install_only_drops_a_request(admin, host_dir):
    _available()
    r = admin.post("/api/panel/update/install")
    assert r.status_code == 200, r.text
    assert r.json()["restarting"] and r.json()["docker"]
    assert json.loads((host_dir / "request.json").read_text())["version"] == "9.9.9"
    state = admin.get("/api/panel/update").json()
    assert state["pending"] and state["enabled"]


def test_release_without_docker_package_is_refused(admin, host_dir):
    _available(docker=False)
    assert admin.post("/api/panel/update/install").status_code == 400
    assert not (host_dir / "request.json").exists()


def test_host_status_is_read_and_stale_status_ignored(host_dir):
    status = {"phase": "rolled_back", "message": "le panel ne répond pas", "version": "9.9.9",
              "updated_at": int(time.time()), "extra": "ignoré"}
    (host_dir / "status.json").write_text(json.dumps(status))
    st = updater.public_state()
    assert st["docker"] and st["host"]["phase"] == "rolled_back" and "extra" not in st["host"]
    (host_dir / "status.json").write_text(json.dumps(status | {"updated_at": 1}))
    assert updater.public_state()["host"] == {}
    (host_dir / "status.json").write_text("[1, 2]")
    assert updater.public_state()["host"] == {}


def test_moderator_cannot_request_update(client, host_dir):
    from beammp_panel.db import db
    from beammp_panel.security import hash_password
    from .conftest import login
    db().run("INSERT INTO users (username, password, role, created_at) VALUES ('modo', ?, 'admin', 'x')",
             [hash_password("motdepasse-modo")])
    login(client, "modo", "motdepasse-modo")
    _available()
    assert client.post("/api/panel/update/install").status_code == 403
    assert not (host_dir / "request.json").exists()


# ── install.sh ────────────────────────────────────────────────

def test_install_sh_embeds_the_release_public_key():
    text = (ROOT / "install.sh").read_text()
    pem = re.search(r"-----BEGIN PUBLIC KEY-----\n(\S+)\n-----END PUBLIC KEY-----", text).group(1)
    der = base64.b64decode(pem)
    raw = (ROOT / "build" / "update_public.b64").read_text().strip()
    assert der == bytes.fromhex("302a300506032b6570032100") + base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))


def test_install_sh_syntax():
    subprocess.run(["bash", "-n", str(ROOT / "install.sh")], check=True)


def test_install_sh_refuses_older_version_from_panel():
    """La garde anti-retour arrière d'install.sh, extraite et exécutée seule."""
    text = (ROOT / "install.sh").read_text()
    fn = re.search(r"^version_lt\(\) \{\n.*?^\}\n", text, re.M | re.S).group(0)
    def lt(a, b):
        return subprocess.run(["bash", "-c", fn + f'version_lt "{a}" "{b}"']).returncode == 0
    assert lt("3.2.1", "3.3.0") and lt("3.3.0-beta.1", "3.3.0") and lt(VERSION, "99.0.0")
    assert not lt("3.3.0", "3.2.1") and not lt("3.3.0", "3.3.0")
