"""#4521 : BeamNG.Earth est une carte du panel. Activer une autre carte range son zip ET son plugin ; le réactiver les
remet ; la section Earth n'est visible que s'il est la carte active ; les réglages et la version suivent le plugin rangé."""
from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from beammp_panel import config as C, earth, earth_release
from beammp_panel.db import db

from .conftest import login, map_zip
from .test_earth import MAIN_LUA, mod_zip

URL = "/api/i/default"


@pytest.fixture()
def serveur(env):
    """Earth installé et actif (Map = beamng_earth), plus une ancienne carte « Site industriel » restée dans Client/."""
    res = env / "res"
    (res / "Server" / "BeamNGEarth").mkdir(parents=True)
    (res / "Server" / "BeamNGEarth" / "main.lua").write_text(MAIN_LUA)
    (res / "Server" / "BeamNGEarth" / "settings.json").write_text('{"weather": "rain"}')
    (res / "Client").mkdir(exist_ok=True)
    (res / "Client" / "beamng_earth.zip").write_bytes(mod_zip("1.10.0-beta.fr.2"))
    cfg = Path(C.config.instances[0].beammp.config_path)
    cfg.write_text(cfg.read_text().replace('Map = "/levels/gridmap_v2/info.json"', 'Map = "/levels/beamng_earth/info.json"'))
    return res


def demarrer(env_ok=True):
    from beammp_panel.app import create_app
    return TestClient(create_app(start_watchers=False, frontend_dir=""))


def ajouter(c, nom, niveau):
    r = c.post(f"{URL}/mods/upload", data={"name": nom, "type": "map"},
               files={"file": (f"{niveau}.zip", map_zip(niveau), "application/zip")})
    assert r.status_code == 200, r.text
    return r.json()


def carte(nom):
    return db().one("SELECT * FROM mods WHERE name = ? AND type = 'map'", [nom])


def test_earth_entre_dans_les_cartes_au_demarrage(serveur):
    assert 'Map = "/levels/beamng_earth/info.json"' in Path(C.config.instances[0].beammp.config_path).read_text()
    with demarrer() as c:
        e = carte("BeamNG.Earth")
        assert e and e["map_id"] == "beamng_earth" and e["active"] == 1 and e["filename"] == "beamng_earth.zip"
        login(c)
        assert c.get(f"{URL}/earth").json()["active"] is True
    with demarrer():                                         # second démarrage : pas de doublon
        assert db().one("SELECT COUNT(*) AS n FROM mods WHERE filename = 'beamng_earth.zip'")["n"] == 1


def test_autre_carte_range_earth_puis_retour(serveur):
    with demarrer() as c:
        login(c)
        site = ajouter(c, "Site industriel", "industrial")              # arrive inactive (Earth est active)
        assert c.post(f"{URL}/maps/activate", json={"mod_id": site["id"]}).status_code == 200
        assert not (serveur / "Client" / "beamng_earth.zip").exists()
        assert (serveur / "inactive_map" / "beamng_earth.zip").is_file()
        assert not (serveur / "Server" / "BeamNGEarth").exists()        # BeamMP ne charge plus le plugin
        assert (serveur / "inactive_plugins" / "BeamNGEarth" / "main.lua").is_file()
        e = c.get(f"{URL}/earth").json()
        assert e["installed"] is True and e["active"] is False
        assert e["file"] == {"weather": "rain"}                          # réglages lus dans le plugin rangé
        assert earth_release.installed_version(C.config.instances[0]) == "1.10.0-beta.fr.2"

        assert c.post(f"{URL}/maps/activate", json={"mod_id": carte("BeamNG.Earth")["id"]}).status_code == 200
        assert (serveur / "Client" / "beamng_earth.zip").is_file()
        assert (serveur / "Server" / "BeamNGEarth" / "main.lua").is_file()
        assert not (serveur / "inactive_plugins" / "BeamNGEarth").exists()
        assert (serveur / "inactive_map" / "industrial.zip").is_file()     # l'autre carte rangée
        assert 'Map = "/levels/beamng_earth/info.json"' in Path(C.config.instances[0].beammp.config_path).read_text()
        assert c.get(f"{URL}/earth").json()["active"] is True


def test_zip_reste_dans_client_range_quand_meme(serveur):
    """Base réalignée sur Map = beamng_earth (l'ancienne carte n'est plus active en base) mais son zip est resté dans
    Client/ : la prochaine activation le range quand même (vu en prod le 27/11, #4745)."""
    with demarrer() as c:
        login(c)
        site = ajouter(c, "Site industriel", "industrial")
        (serveur / "inactive_map" / "industrial.zip").rename(serveur / "Client" / "industrial.zip")
        assert carte("Site industriel")["active"] == 0
        autre = ajouter(c, "Utah", "utah")
        assert c.post(f"{URL}/maps/activate", json={"mod_id": autre["id"]}).status_code == 200
        assert not (serveur / "Client" / "industrial.zip").exists()
        assert (serveur / "inactive_map" / "industrial.zip").is_file()
        del site


def test_earth_ne_se_supprime_pas(serveur):
    with demarrer() as c:
        login(c)
        assert c.delete(f"{URL}/mods/{carte('BeamNG.Earth')['id']}").status_code == 403
        assert (serveur / "Client" / "beamng_earth.zip").is_file()


def test_jamais_d_ecrasement(serveur):
    inst = C.config.instances[0]
    (serveur / "inactive_plugins" / "BeamNGEarth").mkdir(parents=True)
    assert earth.set_active(inst, False) is False                       # destination occupée : rien ne bouge
    assert (serveur / "Server" / "BeamNGEarth" / "main.lua").is_file()


def test_sans_earth_rien_ne_change(env):
    with demarrer() as c:
        login(c)
        assert db().one("SELECT COUNT(*) AS n FROM mods WHERE filename = 'beamng_earth.zip'")["n"] == 0
        assert c.get(f"{URL}/earth").json() == {"installed": False, "active": False}
