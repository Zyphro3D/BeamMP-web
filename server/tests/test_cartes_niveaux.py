"""#4520 : le niveau d'une carte est lu dans son zip (ajout, activation, réparation au démarrage) ; un pack à
plusieurs niveaux demande le choix ; « Activer » n'est plus jamais sans effet."""
from __future__ import annotations

import json
from pathlib import Path

from beammp_panel import config as C
from beammp_panel.db import db
from beammp_panel.modstate import repair_map_ids

from .conftest import make_zip, map_zip, png_bytes

URL = "/api/i/default"


def envoyer(admin, data: bytes, filename: str, name: str, **extra):
    return admin.post(f"{URL}/mods/upload", data={"name": name, "type": "map", **extra},
                      files={"file": (filename, data, "application/zip")})


def pack(*niveaux: str) -> bytes:
    return make_zip({f"levels/{n}/info.json": json.dumps({"title": n}) for n in niveaux}
                    | {f"levels/{n}/preview.jpg": png_bytes() for n in niveaux})


def config_map() -> str:
    return Path(C.config.instances[0].beammp.config_path).read_text()


def test_niveau_lu_dans_le_zip_a_l_ajout(admin):
    r = envoyer(admin, map_zip("utah"), "utah.zip", "Utah")
    assert r.status_code == 200, r.text
    assert r.json()["map_id"] == "utah"


def test_champ_rempli_garde(admin):
    assert envoyer(admin, map_zip("utah"), "utah.zip", "Utah", map_id="autre_nom").json()["map_id"] == "autre_nom"


def test_activer_une_carte_sans_identifiant(admin):
    envoyer(admin, map_zip("italy"), "italy.zip", "Italy")                      # première carte : active
    mod = envoyer(admin, map_zip("utah"), "utah.zip", "Utah").json()
    db().run("UPDATE mods SET map_id = NULL WHERE id = ?", [mod["id"]])         # comme les 48 cartes de la prod
    r = admin.post(f"{URL}/maps/activate", json={"mod_id": mod["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["activated"] == "utah"
    assert db().one("SELECT map_id, active FROM mods WHERE id = ?", [mod["id"]]) == {"map_id": "utah", "active": 1}
    assert 'Map = "/levels/utah/info.json"' in config_map()


def test_pack_a_plusieurs_niveaux(admin):
    envoyer(admin, map_zip("italy"), "italy.zip", "Italy")
    mod = envoyer(admin, pack("canyon", "desert"), "pack.zip", "Pack").json()
    assert mod["map_id"] is None
    r = admin.post(f"{URL}/maps/activate", json={"mod_id": mod["id"]})
    assert r.status_code == 409 and r.json()["levels"] == ["canyon", "desert"]
    assert admin.post(f"{URL}/maps/activate", json={"mod_id": mod["id"], "level": "foret"}).status_code == 400
    r = admin.post(f"{URL}/maps/activate", json={"mod_id": mod["id"], "level": "desert"})
    assert r.status_code == 200, r.text
    assert db().one("SELECT map_id FROM mods WHERE id = ?", [mod["id"]])["map_id"] == "desert"
    assert 'Map = "/levels/desert/info.json"' in config_map()


def test_identifiant_faux_repris_du_zip(admin):
    envoyer(admin, map_zip("italy"), "italy.zip", "Italy")
    mod = envoyer(admin, map_zip("utah"), "utah.zip", "Utah", map_id="mauvais_nom").json()
    assert admin.post(f"{URL}/maps/activate", json={"mod_id": mod["id"]}).json()["activated"] == "utah"


def test_meme_niveau_dans_deux_zips(admin):
    envoyer(admin, map_zip("italy"), "italy.zip", "Italy")
    a = envoyer(admin, map_zip("utah"), "utah_v1.zip", "Utah v1").json()
    b = envoyer(admin, map_zip("utah"), "utah_v2.zip", "Utah v2").json()
    assert admin.post(f"{URL}/maps/activate", json={"mod_id": b["id"]}).status_code == 200
    assert db().one("SELECT active FROM mods WHERE id = ?", [b["id"]])["active"] == 1
    assert db().one("SELECT active FROM mods WHERE id = ?", [a["id"]])["active"] == 0


def test_zip_sans_niveau(admin):
    envoyer(admin, map_zip("italy"), "italy.zip", "Italy")
    mod = envoyer(admin, make_zip({"readme.txt": "rien"}), "vide.zip", "Vide").json()
    r = admin.post(f"{URL}/maps/activate", json={"mod_id": mod["id"]})
    assert r.status_code == 400 and "levels/" in r.json()["error"]


def test_mod_id_invalide(admin):
    for v in ("1", True, 99999):
        assert admin.post(f"{URL}/maps/activate", json={"mod_id": v}).status_code in (400, 404), v


def test_reparation_au_demarrage(admin):
    envoyer(admin, map_zip("italy"), "italy.zip", "Italy")
    seul = envoyer(admin, map_zip("utah"), "utah.zip", "Utah").json()
    multi = envoyer(admin, pack("canyon", "desert"), "pack.zip", "Pack").json()
    db().run("UPDATE mods SET map_id = NULL WHERE id IN (?, ?)", [seul["id"], multi["id"]])
    assert repair_map_ids(C.config.instances) == 1
    assert db().one("SELECT map_id FROM mods WHERE id = ?", [seul["id"]])["map_id"] == "utah"
    assert db().one("SELECT map_id FROM mods WHERE id = ?", [multi["id"]])["map_id"] is None


def test_ancienne_forme_toujours_acceptee(admin):
    envoyer(admin, map_zip("italy"), "italy.zip", "Italy")
    envoyer(admin, map_zip("utah"), "utah.zip", "Utah")
    assert admin.post(f"{URL}/maps/activate", json={"map_id": "utah"}).status_code == 200
