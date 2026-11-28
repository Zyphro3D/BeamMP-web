"""Bibliothèque de mods commune : un zip, des liens dans Client/ des serveurs où il est actif."""

from __future__ import annotations

import asyncio
import os
import sys

import pytest
from starlette.testclient import TestClient

from beammp_panel import config as C
from beammp_panel import library, supervisor
from beammp_panel.app import create_app
from beammp_panel.db import db

from .conftest import login, make_zip, map_zip, vehicle_zip
from .test_runner import make_exe

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="liens symboliques et exécutable factice")

KEY = "abcd1234-ef56-7890-abcd-1234567890ab"  # gitleaks:allow (valeur de test)


@pytest.fixture()
def panel(env, monkeypatch):
    """Panel en supervision locale, bibliothèque en service, et un second serveur ajouté par le bouton."""
    monkeypatch.setenv("BEAMMP_SERVER_EXE", str(make_exe(env / "srv" / "BeamMP-Server")))
    monkeypatch.setenv("BEAMMP_SERVERS_PATH", str(env / "servers"))
    monkeypatch.setenv("BEAMMP_LIBRARY_PATH", str(env / "bibliotheque"))
    C.set_config(C.load_config())
    supervisor._servers.clear()
    with TestClient(create_app()) as client:
        login(client)
        r = client.post("/api/admin/servers", json={"name": "Drift", "port": 30900, "authKey": KEY})
        assert r.status_code == 201, r.text
        yield client, env
    asyncio.run(supervisor.stop_all())


def upload(client, inst: str, data: bytes, filename: str, type_: str = "vehicle", name: str = "Dynamo"):
    return client.post(f"/api/i/{inst}/mods/upload", data={"name": name, "type": type_},
                       files={"file": (filename, data, "application/zip")})


def client_path(inst_id: str, filename: str) -> str:
    inst = next(i for i in C.config.instances if i.id == inst_id)
    return library.client_file(inst, filename)


def test_partage_entre_serveurs(panel):
    client, env = panel
    lib = env / "bibliotheque" / "dynamo.zip"
    mod = upload(client, "default", vehicle_zip(), "dynamo.zip").json()
    assert lib.is_file() and not lib.is_symlink()
    link = client_path("default", "dynamo.zip")
    assert os.path.islink(link) and os.path.realpath(link) == str(lib)
    assert not os.path.exists(os.path.join(os.path.dirname(link), "..", "inactive_mod", "dynamo.zip"))

    # Le même zip envoyé sur l'autre serveur : refusé, il s'ajoute depuis la bibliothèque
    assert upload(client, "drift", vehicle_zip(), "dynamo.zip").status_code == 409
    r = client.post("/api/i/drift/mods/from-library", json={"filename": "dynamo.zip"})
    assert r.status_code == 200, r.text
    copy = r.json()
    assert copy["active"] and copy["name"] == mod["name"] and copy["metadata"] == mod["metadata"]
    assert copy["image"] and copy["image"] != mod["image"]          # image à soi
    assert os.path.realpath(client_path("drift", "dynamo.zip")) == str(lib)
    assert client.post("/api/i/drift/mods/from-library", json={"filename": "dynamo.zip"}).status_code == 409

    items = client.get("/api/library").json()
    assert items["enabled"] and [i["filename"] for i in items["items"]] == ["dynamo.zip"]
    assert {s["id"] for s in items["items"][0]["servers"]} == {"default", "drift"}

    # Désactivé sur un serveur : son lien part, le zip et l'autre lien restent
    assert client.post(f"/api/i/default/mods/{mod['id']}/toggle").status_code == 200
    assert not os.path.lexists(client_path("default", "dynamo.zip"))
    assert lib.is_file() and os.path.islink(client_path("drift", "dynamo.zip"))
    assert client.post(f"/api/i/default/mods/{mod['id']}/toggle").status_code == 200
    assert os.path.islink(client_path("default", "dynamo.zip"))

    # Retiré d'un serveur : le zip reste pour l'autre ; retiré du dernier : supprimé, plus aucun lien
    assert client.delete("/api/library/dynamo.zip").status_code == 409
    assert client.delete(f"/api/i/default/mods/{mod['id']}").status_code == 200
    assert lib.is_file() and not os.path.lexists(client_path("default", "dynamo.zip"))
    assert (env / "data" / "images" / copy["image"]).is_file()
    assert client.delete(f"/api/i/drift/mods/{copy['id']}").status_code == 200
    assert not lib.exists() and not os.path.lexists(client_path("drift", "dynamo.zip"))


def test_carte_ajoutee_rangee_si_une_carte_est_active(panel):
    client, env = panel
    upload(client, "drift", map_zip("utah"), "utah.zip", "map", "Utah")
    upload(client, "drift", map_zip("italy"), "italy.zip", "map", "Italy")     # rangée : utah est active
    assert not os.path.lexists(client_path("drift", "italy.zip"))
    upload(client, "default", map_zip("eifel"), "eifel.zip", "map", "Eifel")
    r = client.post("/api/i/default/mods/from-library", json={"filename": "utah.zip"}).json()
    assert not r["active"] and r["map_id"] == "utah"
    assert not os.path.lexists(client_path("default", "utah.zip"))

    # Activer une carte : l'ancienne perd son lien, la nouvelle en reçoit un
    assert client.post("/api/i/default/maps/activate", json={"map_id": "utah", "mod_id": r["id"]}).status_code == 200
    assert os.path.islink(client_path("default", "utah.zip"))
    assert not os.path.lexists(client_path("default", "eifel.zip"))
    assert (env / "bibliotheque" / "eifel.zip").is_file()


def test_migration_et_homonymes(panel):
    client, env = panel
    default = C.config.instances[0]
    drift = next(i for i in C.config.instances if i.id == "drift")
    # Avant la bibliothèque : chaque serveur range ses zips chez lui ; deux serveurs ont un « pack.zip » différent
    rows = []
    for inst, sub, data, active in ((default, "Client", make_zip({"a.txt": "A"}), 1),
                                    (drift, "inactive_mod", make_zip({"b.txt": "B"}), 0),
                                    (drift, "Client", None, 1)):
        fn = "pack.zip" if data else "commun.zip"
        if data is None:
            data = make_zip({"c.txt": "C"})
            for i in (default, drift):            # même zip, en double sur les deux serveurs
                os.makedirs(os.path.join(i.beammp.resources_path, "Client"), exist_ok=True)
                with open(os.path.join(i.beammp.resources_path, "Client", fn), "wb") as f:
                    f.write(data)
                rows.append(db().run("INSERT INTO mods (instance_id, name, type, filename, active, created_at) "
                                     "VALUES (?, ?, 'mod', ?, 1, '')", [i.id, fn, fn]).lastrowid)
            continue
        os.makedirs(os.path.join(inst.beammp.resources_path, sub), exist_ok=True)
        with open(os.path.join(inst.beammp.resources_path, sub, fn), "wb") as f:
            f.write(data)
        rows.append(db().run("INSERT INTO mods (instance_id, name, type, filename, active, created_at) "
                             "VALUES (?, ?, 'mod', ?, ?, '')", [inst.id, fn, fn, active]).lastrowid)

    assert library.migrate(C.config.instances) == 4
    lib = env / "bibliotheque"
    assert sorted(os.listdir(lib)) == ["commun.zip", "pack-2.zip", "pack.zip"]
    assert db().one("SELECT filename FROM mods WHERE id = ?", [rows[1]])["filename"] == "pack-2.zip"
    assert os.path.realpath(client_path("default", "pack.zip")) == str(lib / "pack.zip")
    assert not os.path.lexists(client_path("drift", "pack-2.zip"))                 # inactif : pas de lien
    for i in ("default", "drift"):
        assert os.path.realpath(client_path(i, "commun.zip")) == str(lib / "commun.zip")
    assert library.migrate(C.config.instances) == 0                                # rien à refaire


def test_lien_casse_signale_et_retire(panel):
    client, env = panel
    upload(client, "default", vehicle_zip(), "dynamo.zip")
    os.replace(env / "bibliotheque" / "dynamo.zip", env / "dynamo-ailleurs.zip")    # zip retiré à la main
    issues = client.get("/api/admin/i/default/consistency").json()["issues"]
    broken = next(i for i in issues if i["id"] == "broken_link_dynamo.zip")
    r = client.post("/api/admin/i/default/consistency/fix", json={"fix": broken["fix"], "meta": broken["meta"]})
    assert r.status_code == 200
    assert not os.path.lexists(client_path("default", "dynamo.zip"))
    assert (env / "dynamo-ailleurs.zip").is_file()


def test_sans_supervision_pas_de_bibliotheque(env, monkeypatch):
    """Ancien service systemd : BeamMP-Server tourne sur l'hôte et ne suivrait pas un lien vers /beammp/…"""
    monkeypatch.setenv("BEAMMP_LIBRARY_PATH", str(env / "bibliotheque"))
    C.set_config(C.load_config())
    with TestClient(create_app(start_watchers=False, frontend_dir="")) as client:
        login(client)
        assert client.get("/api/library").json() == {"enabled": False, "items": []}
        upload(client, "default", vehicle_zip(), "dynamo.zip")
        path = client_path("default", "dynamo.zip")
        assert os.path.isfile(path) and not os.path.islink(path)
        assert not (env / "bibliotheque").exists()


def test_serveur_archive_garde_ses_zips(panel):
    client, env = panel
    mod = upload(client, "default", vehicle_zip(), "dynamo.zip").json()
    assert client.post("/api/i/drift/mods/from-library", json={"filename": "dynamo.zip"}).status_code == 200
    assert client.delete("/api/admin/servers/drift").status_code == 200
    assert client.delete(f"/api/i/default/mods/{mod['id']}").status_code == 200
    lib = env / "bibliotheque" / "dynamo.zip"
    assert lib.is_file()                                    # le serveur archivé l'avait encore
    item = client.get("/api/library").json()["items"][0]
    assert item["servers"] == [] and item["archived"] == ["drift"]
    assert client.delete("/api/library/dynamo.zip").status_code == 200
    assert not lib.exists() and not db().one("SELECT id FROM mods WHERE filename = 'dynamo.zip'")
