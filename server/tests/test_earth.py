"""BeamNG.Earth : réglages du plugin (settings.json) et son état (state.json)."""

from __future__ import annotations

import json
import time

import pytest

from beammp_panel import earth

MAIN_LUA = """local G = {}
G.SETTINGS_FILE = 'settings.json'
G.LISTED = true
G.TIME = 'real'
-- With a fixed time: 0 = it stays there
G.TIME_SPEED = 0
G.WEATHER = 'real'
G.SHARE_STORE_MB = 2048     -- the store's size at most
G.SHARE_OUT_KBPS = 1024     -- KB/s
G.MEET_M = 3000             -- a joining player farther than this
"""


@pytest.fixture()
def plugin(env):
    d = env / "res" / "Server" / "BeamNGEarth"
    d.mkdir(parents=True)
    (d / "main.lua").write_text(MAIN_LUA)
    return d


def state(**over):
    s = {"v": 1, "t": int(time.time()), "uptime": 42,
         "settings": {"listed": True, "time": "real", "timeSpeed": 0, "weather": "fog", "shareStoreMb": 2048,
                      "shareOutKbps": 1024, "meetM": 3000},
         "warnings": {}, "players": [{"pid": 0, "name": "Zoe", "lat": 43.6, "lon": 1.44, "h": 90, "joined": 30}],
         "store": {"bytes": 1000, "items": 3, "capBytes": 2147483648}, "packs": {}, "stats": {"items_in": 2}}
    s.update(over)
    return json.dumps(s)


def test_not_installed(admin):
    r = admin.get("/api/i/default/earth")
    assert r.status_code == 200 and r.json() == {"installed": False}
    assert admin.put("/api/i/default/earth/settings", json={}).status_code == 404


def test_overview_defaults_from_main_lua(admin, plugin):
    r = admin.get("/api/i/default/earth").json()
    assert r["installed"] and r["supportsSettings"]
    assert r["defaults"] == {"listed": True, "time": "real", "timeSpeed": 0, "weather": "real", "shareStoreMb": 2048,
                             "shareOutKbps": 1024, "meetM": 3000}
    assert r["file"] == {} and r["fileError"] is None and r["state"] is None
    assert r["effective"] == r["defaults"]
    # la config de test : Private = true -> connexion directe ; la clé ne sort jamais
    assert r["listing"] == "direct"
    assert "NE-DOIT-JAMAIS-SORTIR" not in json.dumps(r)


def test_put_settings_writes_the_file_and_logs(admin, plugin):
    r = admin.put("/api/i/default/earth/settings", json={"weather": "rain", "time": "20:30", "timeSpeed": 60,
                                                          "listed": False, "shareStoreMb": 512.0, "meetM": None})
    assert r.status_code == 200, r.text
    assert r.json()["changed"] == ["listed", "shareStoreMb", "time", "timeSpeed", "weather"]
    written = json.loads((plugin / "settings.json").read_text())
    assert written == {"listed": False, "time": "20:30", "timeSpeed": 60, "weather": "rain", "shareStoreMb": 512}
    assert list(written) == ["listed", "time", "timeSpeed", "weather", "shareStoreMb"]     # (l'ordre du plugin)
    o = admin.get("/api/i/default/earth").json()
    assert o["file"] == written and o["effective"]["weather"] == "rain" and o["effective"]["meetM"] == 3000
    acts = admin.get("/api/i/default/activity").json()
    assert any(a["type"] == "earth_settings" and "météo" in a["message"] for a in acts)
    # tout retirer : retour aux valeurs de main.lua
    assert admin.put("/api/i/default/earth/settings", json={}).json()["file"] == {}
    assert json.loads((plugin / "settings.json").read_text()) == {}


@pytest.mark.parametrize("body", [
    {"weather": "hail"}, {"weather": "Rain"}, {"time": "25:00"}, {"time": "noon"}, {"time": 20}, {"timeSpeed": -1},
    {"timeSpeed": "60"}, {"timeSpeed": 5000}, {"timeSpeed": True}, {"listed": "yes"}, {"shareStoreMb": 1.5},
    {"shareStoreMb": 8}, {"shareOutKbps": float("nan")}, {"meetM": -3}, {"sound": 3}, [1, 2],
])
def test_put_settings_refuses_what_the_plugin_would(admin, plugin, body):
    if isinstance(body, dict) and any(isinstance(v, float) and v != v for v in body.values()):
        r = admin.put("/api/i/default/earth/settings", content='{"shareOutKbps": NaN}',
                      headers={"Content-Type": "application/json"})
    else:
        r = admin.put("/api/i/default/earth/settings", json=body)
    assert r.status_code == 400, (body, r.text)
    assert not (plugin / "settings.json").exists()


def test_settings_need_an_admin(client, plugin):
    assert client.get("/api/i/default/earth").status_code == 401
    assert client.put("/api/i/default/earth/settings", json={"weather": "rain"}).status_code == 401


def test_state_fresh_and_empty_lists(admin, plugin):
    (plugin / "state.json").write_text(state())
    o = admin.get("/api/i/default/earth").json()
    s = o["state"]
    assert s["fresh"] and s["uptime"] == 42 and s["warnings"] == [] and s["packs"] == []
    assert s["players"] == [{"pid": 0, "name": "Zoe", "lat": 43.6, "lon": 1.44, "h": 90, "joined": 30}]
    assert s["store"] == {"bytes": 1000, "items": 3, "capBytes": 2147483648}
    assert o["effective"]["weather"] == "fog"        # (ce que le plugin applique vraiment)


def test_stale_or_broken_state(admin, plugin):
    (plugin / "state.json").write_text(state(t=int(time.time()) - 600, players={}))
    o = admin.get("/api/i/default/earth").json()
    assert o["state"]["fresh"] is False and o["state"]["players"] == []
    assert o["effective"]["weather"] == "real"       # (plugin arrêté : les fichiers, pas l'état périmé)
    (plugin / "state.json").write_text("{pas du json")
    assert admin.get("/api/i/default/earth").json()["state"] is None


def test_broken_settings_file_is_reported(admin, plugin):
    (plugin / "settings.json").write_text("[1, 2]")
    o = admin.get("/api/i/default/earth").json()
    assert o["file"] == {} and "objet JSON" in o["fileError"]


def test_old_plugin_without_settings_support(admin, plugin):
    (plugin / "main.lua").write_text(MAIN_LUA.replace("G.SETTINGS_FILE = 'settings.json'\n", ""))
    assert admin.get("/api/i/default/earth").json()["supportsSettings"] is False


@pytest.mark.parametrize("toml,listed,expected", [
    ('Private = false\nAuthKey = "abc"\n', True, "earth"),
    ('Private = false\nAuthKey = "abc"\n', False, "beammp"),
    ('Private = false\nAuthKey = ""\n', True, "direct"),
    ('Private = true\nAuthKey = "abc"\n', True, "direct"),
])
def test_listing(env, plugin, toml, listed, expected):
    from beammp_panel import config as C
    inst = C.get_instance("default")
    (plugin / "settings.json").write_text(json.dumps({"listed": listed}))
    assert earth.overview(inst, toml)["listing"] == expected
