"""Bouton « Ajouter un serveur » : création, démarrage à chaud, retrait avec archivage."""

from __future__ import annotations

import asyncio
import json
import sys
import time

import pytest
from starlette.testclient import TestClient

from beammp_panel import config as C
from beammp_panel import servers, supervisor
from beammp_panel.app import create_app
from beammp_panel.db import db

from .conftest import login
from .test_runner import make_exe

KEY = "abcd1234-ef56-7890-abcd-1234567890ab"  # gitleaks:allow (valeur de test)


@pytest.fixture()
def local(env, monkeypatch):
    """Panel en supervision locale (comme l'appli Windows) avec un BeamMP-Server factice."""
    exe = make_exe(env / "srv" / "BeamMP-Server")
    monkeypatch.setenv("BEAMMP_SERVER_EXE", str(exe))
    monkeypatch.setenv("BEAMMP_SERVERS_PATH", str(env / "servers"))
    C.set_config(C.load_config())
    supervisor._servers.clear()
    with TestClient(create_app()) as client:
        yield login(client), env
    asyncio.run(supervisor.stop_all())


def test_add_requires_supervision(admin):
    r = admin.get("/api/admin/servers")
    assert r.status_code == 200 and r.json()["canAdd"] is False
    r = admin.post("/api/admin/servers", json={"name": "Event", "port": 30900, "authKey": KEY})
    assert r.status_code == 409


@pytest.mark.skipif(sys.platform == "win32", reason="exécutable factice en script shebang")
def test_add_start_list_remove(local):
    client, env = local
    listing = client.get("/api/admin/servers").json()
    # Le premier serveur écoute 30814 (son ServerConfig.toml), sans BEAMMP_SERVER_PORT : 30815 est proposé
    assert listing["canAdd"] and listing["nextPort"] == 30815, listing
    assert listing["servers"][0]["port"] == 30814

    for bad in ({"name": "", "port": 30900, "authKey": KEY},
                {"name": "X", "port": 80, "authKey": KEY},
                {"name": "X", "port": 30900, "authKey": "court"},
                {"name": "X", "port": 30900, "authKey": 'a"b\nInjecte = 1'}):
        assert client.post("/api/admin/servers", json=bad).status_code == 400

    r = client.post("/api/admin/servers", json={"name": "Soirée drift", "port": 30900, "authKey": KEY})
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["server"]["id"] == "soiree-drift" and data["started"], data
    d = env / "servers" / "soiree-drift"
    toml = (d / "ServerConfig.toml").read_text()
    assert 'Name = "Soirée drift"' in toml and "Port = 30900" in toml and KEY in toml
    assert (d / "Resources" / "Client").is_dir() and (d / "Resources" / "Server").is_dir()

    # Le serveur tourne dans son dossier, et le reste du panel le connaît aussitôt.
    end = time.time() + 10
    while time.time() < end and "ALL SYSTEMS" not in (d / "Server.log").read_text():
        time.sleep(0.2)
    assert str(d) in (d / "Server.log").read_text()
    ids = [i["id"] for i in client.get("/api/instances").json()]
    assert ids == ["default", "soiree-drift"]
    assert client.get("/api/i/soiree-drift/server/state").json()["running"]
    assert KEY not in client.get("/api/admin/servers").text          # la clé ne ressort jamais

    # Même port refusé ; même nom = nouvel identifiant.
    assert client.post("/api/admin/servers", json={"name": "Autre", "port": 30900, "authKey": KEY}).status_code == 400
    r2 = client.post("/api/admin/servers", json={"name": "Soirée drift", "port": 30901, "authKey": KEY})
    assert r2.json()["server"]["id"] == "soiree-drift-2"

    # La configuration rechargée (redémarrage du panel) retrouve les serveurs ajoutés.
    assert [i.id for i in C.load_config().instances] == ["default", "soiree-drift", "soiree-drift-2"]

    # Le serveur de l'installation ne se retire pas.
    assert client.delete("/api/admin/servers/default").status_code == 400

    sp = supervisor._servers["soiree-drift"]
    r = client.delete("/api/admin/servers/soiree-drift")
    assert r.status_code == 200, r.text
    assert not sp.running() and "soiree-drift" not in supervisor._servers
    assert not d.exists()
    archived = list((env / "servers" / "_archives").iterdir())
    assert len(archived) == 1 and (archived[0] / "ServerConfig.toml").is_file()
    assert [e["id"] for e in json.loads((env / "data" / "servers.json").read_text())["servers"]] == ["soiree-drift-2"]
    assert client.get("/api/i/soiree-drift/server/state").status_code == 404

    # Un identifiant archivé n'est jamais réutilisé.
    r3 = client.post("/api/admin/servers", json={"name": "Soirée drift", "port": 30902, "authKey": KEY})
    assert r3.json()["server"]["id"] == "soiree-drift-3"


def test_instance_port_reads_server_config(env, monkeypatch):
    """Le port vient du ServerConfig.toml ; BEAMMP_SERVER_PORT puis 30814 seulement en secours."""
    cfg = env / "ServerConfig.toml"
    monkeypatch.setenv("BEAMMP_SERVER_PORT", "30814")
    cfg.write_text(cfg.read_text().replace("Port = 30814", "Port = 30900   # choisi à la main"))
    C.set_config(C.load_config())
    base = C.config.instances[0]
    assert servers.instance_port(base) == 30900
    assert servers.next_port([base]) == 30814
    with pytest.raises(ValueError, match="déjà utilisé"):
        servers.validate("X", 30900, KEY, [base])
    cfg.unlink()                       # fichier illisible : la variable, puis le défaut de BeamMP
    assert servers.instance_port(base) == 30814
    monkeypatch.delenv("BEAMMP_SERVER_PORT")
    C.set_config(C.load_config())
    assert servers.next_port(C.config.instances) == 30815


def test_admin_cannot_add(local):
    client, _ = local
    db().run("UPDATE users SET role = 'admin' WHERE username = 'boss'")   # admin, pas superadmin
    assert client.get("/api/admin/servers").status_code == 200
    assert client.post("/api/admin/servers", json={"name": "X", "port": 30950, "authKey": KEY}).status_code == 403
    assert client.delete("/api/admin/servers/x").status_code == 403


def test_registry_ignores_bad_entries(env, monkeypatch):
    (env / "data").mkdir(exist_ok=True)
    (env / "data" / "servers.json").write_text(json.dumps({"servers": [
        {"id": "../etc", "name": "x", "port": 30900},
        {"id": "ok", "name": "Bon", "port": 30901},
        {"id": "port", "name": "x", "port": "30902"}]}))
    assert [e["id"] for e in servers.load_registry()] == ["ok"]
    (env / "data" / "servers.json").write_text("{pas du json")
    assert servers.load_registry() == []


def test_switch_to_runner_request(env, monkeypatch):
    """Installation Docker sur l'ancien service systemd : le bouton demande à install.sh la bascule."""
    from beammp_panel import updater
    upd = env / "update"
    upd.mkdir()
    monkeypatch.setattr(updater, "UPDATE_DIR", upd)
    monkeypatch.setenv("BEAMMP_AGENT_URL", "http://127.0.0.1:4445")
    monkeypatch.setenv("BEAMMP_AGENT_TOKEN", "x" * 32)
    monkeypatch.setenv("BEAMMP_AGENT_SERVICE", "beammp.service")
    C.set_config(C.load_config())
    with TestClient(create_app()) as client:
        admin = login(client)
        assert admin.get("/api/admin/servers").json()["canSwitch"] is False     # pas installé par install.sh
        (upd / "agent.json").write_text('{"agent": "systemd"}')
        listing = admin.get("/api/admin/servers").json()
        assert listing["canSwitch"] and not listing["canAdd"]

        assert admin.post("/api/admin/servers/switch").status_code == 200
        req = json.loads((upd / "request.json").read_text())
        assert req["action"] == "jeu" and req["version"] == updater.VERSION
        listing = admin.get("/api/admin/servers").json()
        assert listing["switchPending"] and not listing["canSwitch"]
        assert admin.post("/api/admin/servers/switch").status_code == 400       # une seule demande à la fois

        # install.sh a refusé (service non conforme) : la raison s'affiche, le bouton reste pour réessayer.
        (upd / "request.json").rename(upd / "consommee.json")
        (upd / "jeu-refus.txt").write_text("beammp.service tourne sous root, pas sous l'uid 1000\n")
        listing = admin.get("/api/admin/servers").json()
        assert listing["canSwitch"] and "uid 1000" in listing["refusal"]

        db().run("UPDATE users SET role = 'admin' WHERE username = 'boss'")
        assert admin.post("/api/admin/servers/switch").status_code == 403
