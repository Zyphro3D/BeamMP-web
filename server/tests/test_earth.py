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
         "store": {"mb": 119.7, "items": 3, "capMb": 2048}, "packs": {}, "stats": {"items_in": 2}}
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
    assert s["store"] == {"mb": 119.7, "items": 3, "capMb": 2048}
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


# ── Lot 2 : stock partagé et packs ───────────────────────────────

def pack_bytes(meta=None, items=None, magic=b"BNGEBAKE1\n") -> bytes:
    import struct
    index = json.dumps({"meta": meta or {"bbox": [43.5, 1.3, 43.7, 1.5], "made": "2026-11-24T02:00:00Z",
                                         "bake_format": 1, "plans_format": 14, "signature": "w1s1"},
                        "items": items if items is not None else {"plans/w1s1/14_1_2": [0, 3], "facts/x/y/z": [3, 2]}})
    return magic + struct.pack("<Q", len(index)) + index.encode() + b"abcde"


def test_clear_store_and_reload_packs_are_requests(admin, plugin):
    r = admin.post("/api/i/default/earth/store/clear")
    assert r.status_code == 200 and (plugin / "clear-store.request").exists()
    assert admin.post("/api/i/default/earth/packs/reload").status_code == 200
    assert admin.get("/api/i/default/earth").json()["pending"] == ["clear-store", "reload-packs"]
    acts = admin.get("/api/i/default/activity").json()
    assert any(a["type"] == "earth_store_clear" for a in acts)


def test_upload_list_delete_pack(admin, plugin):
    r = admin.post("/api/i/default/earth/packs/upload", files={"file": ("tarn.bnge", pack_bytes())})
    assert r.status_code == 200, r.text
    assert r.json()["items"] == 2 and (plugin / "bake" / "tarn.bnge").exists()
    assert (plugin / "reload-packs.request").exists()
    assert not list((plugin / "bake").glob("*.part"))
    (plugin / "bake" / "notes.txt").write_text("x")                    # (pas un pack : ignoré)
    (plugin / "bake" / "broken.bnge").write_bytes(b"BNGEBAKE1\n" + b"\xff" * 8)
    packs = admin.get("/api/i/default/earth").json()["packs"]
    assert [p["name"] for p in packs] == ["broken.bnge", "tarn.bnge"]
    assert packs[0]["valid"] is False and packs[1]["valid"] is True and packs[1]["loaded"] is None
    assert packs[1]["meta"]["bbox"] == [43.5, 1.3, 43.7, 1.5] and packs[1]["items"] == 2
    # déjà présent : refusé sans écraser
    assert admin.post("/api/i/default/earth/packs/upload", files={"file": ("tarn.bnge", pack_bytes())}).status_code == 409
    (plugin / "reload-packs.request").unlink()
    assert admin.delete("/api/i/default/earth/packs/tarn.bnge").status_code == 200
    assert not (plugin / "bake" / "tarn.bnge").exists() and (plugin / "reload-packs.request").exists()
    assert admin.delete("/api/i/default/earth/packs/tarn.bnge").status_code == 404


def test_loaded_packs_follow_the_state(admin, plugin):
    (plugin / "bake").mkdir()
    (plugin / "bake" / "a.bnge").write_bytes(pack_bytes())
    (plugin / "bake" / "b.bnge").write_bytes(pack_bytes())
    (plugin / "state.json").write_text(state(packs=["a.bnge"]))
    packs = admin.get("/api/i/default/earth").json()["packs"]
    assert [(p["name"], p["loaded"]) for p in packs] == [("a.bnge", True), ("b.bnge", False)]


@pytest.mark.parametrize("name,data", [
    ("tarn.zip", pack_bytes()), ("tarn.bnge", b"PK\x03\x04 pas un pack"), (".cache.bnge", pack_bytes()),
    ("tarn.bnge", pack_bytes(items=[])), ("t;rm.bnge", pack_bytes()),
])
def test_upload_pack_refused(admin, plugin, name, data):
    r = admin.post("/api/i/default/earth/packs/upload", files={"file": (name, data)})
    assert r.status_code == 400, r.text
    assert not (plugin / "bake").exists() or not any((plugin / "bake").iterdir())


@pytest.mark.parametrize("name", ["../main.lua", "..%2Fmain.lua", "main.lua", "x.bnge/../../main.lua"])
def test_delete_pack_stays_in_bake(admin, plugin, name):
    assert admin.delete(f"/api/i/default/earth/packs/{name}").status_code in (404, 405)
    assert (plugin / "main.lua").exists()


def test_store_and_packs_need_an_admin(client, plugin):
    assert client.post("/api/i/default/earth/store/clear").status_code == 401
    assert client.post("/api/i/default/earth/packs/upload", files={"file": ("a.bnge", pack_bytes())}).status_code == 401
    assert client.delete("/api/i/default/earth/packs/a.bnge").status_code == 401
    assert not (plugin / "clear-store.request").exists()


# ── Assistant de partage (helper.json / helper-state.json) ────────

def helper_state(**over):
    s = {"v": 1, "t": int(time.time()), "version": "1.10.0-beta.fr.2", "enabled": True, "procs": 1, "running": True,
         "pid": 4242, "since": int(time.time()) - 60, "rssMb": 512.3, "cacheMb": 1800.0, "nextStart": None,
         "restarts": 0, "lastExit": None, "error": None, "log": ["helper: 1 planning processes"]}
    s.update(over)
    return json.dumps(s)


def test_helper_not_installed_then_toggle(admin, plugin):
    h = admin.get("/api/i/default/earth").json()["helper"]
    assert h == {"installed": False, "control": {"enabled": False, "procs": 1}, "state": None}
    r = admin.put("/api/i/default/earth/helper", json={"enabled": True, "procs": 2})
    assert r.status_code == 200 and json.loads((plugin / "helper.json").read_text()) == {"enabled": True, "procs": 2}
    (plugin / "helper-state.json").write_text(helper_state())
    h = admin.get("/api/i/default/earth").json()["helper"]
    assert h["installed"] and h["control"] == {"enabled": True, "procs": 2}
    assert h["state"]["running"] and h["state"]["rssMb"] == 512.3 and "pid" not in h["state"]
    acts = admin.get("/api/i/default/activity").json()
    assert any(a["type"] == "earth_helper" and "allumé" in a["message"] for a in acts)


def test_helper_stale_state_means_not_installed(admin, plugin):
    (plugin / "helper-state.json").write_text(helper_state(t=int(time.time()) - 120))
    h = admin.get("/api/i/default/earth").json()["helper"]
    assert h["installed"] is False and h["state"] is None


@pytest.mark.parametrize("body", [{"enabled": "yes"}, {"enabled": True, "procs": 3}, {"enabled": True, "procs": 0},
                                  {"enabled": True, "procs": True}, {"enabled": True, "x": 1}, [True]])
def test_helper_refused(admin, plugin, body):
    assert admin.put("/api/i/default/earth/helper", json=body).status_code == 400
    assert not (plugin / "helper.json").exists()


def test_helper_needs_an_admin(client, plugin):
    assert client.put("/api/i/default/earth/helper", json={"enabled": True}).status_code == 401
