"""BeamNG.Earth : le plugin serveur Resources/Server/BeamNGEarth (fork Zyphro3D/BeamNG.Earth).

Le plugin lit ses réglages dans settings.json (relu toutes les 2 s, sans redémarrage) et écrit son état dans
state.json toutes les 2 s : réglages en vigueur, avertissements, joueurs et leur position, stock partagé, packs.
Le panel écrit settings.json et lit state.json ; il ne touche jamais main.lua (remplacé à chaque mise à jour).
Les règles de validation sont celles du plugin (G.SETTINGS dans main.lua) : une valeur que le plugin refuserait
est refusée ici avec un message, au lieu d'être signalée plus tard dans le journal du serveur.
"""

from __future__ import annotations

import json
import os
import re
import struct
import time
from typing import Any

from .config import InstanceConfig
from .files import delete_file, read_text, resolve_within, safe_basename, write_text

PLUGIN_DIR = os.path.join("Server", "BeamNGEarth")
SETTINGS_FILE = "settings.json"
STATE_FILE = "state.json"
STATE_FRESH_S = 15          # (le plugin l'écrit toutes les 2 s : plus vieux, le serveur ou le plugin est arrêté)
WEATHERS = ("real", "clear", "cloudy", "rain", "storm", "snow", "fog")

# clé du fichier -> nom dans main.lua (G.X), dans l'ordre du plugin
SETTINGS = {
    "listed": "LISTED",
    "time": "TIME",
    "timeSpeed": "TIME_SPEED",
    "weather": "WEATHER",
    "shareStoreMb": "SHARE_STORE_MB",
    "shareOutKbps": "SHARE_OUT_KBPS",
    "meetM": "MEET_M",
}
_TIME_RE = re.compile(r"\s*(\d{1,2}):(\d{2})\s*")


def plugin_dir(inst: InstanceConfig) -> str:
    return os.path.join(inst.beammp.resources_path, PLUGIN_DIR)


def installed(inst: InstanceConfig) -> bool:
    return os.path.isfile(os.path.join(plugin_dir(inst), "main.lua"))


def _number(value: Any, lo: float, hi: float, integer: bool = False) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool) and value == value
            and lo <= value <= hi and (not integer or float(value).is_integer()))


def _valid_time(value: Any) -> bool:
    if value == "real":
        return True
    m = _TIME_RE.fullmatch(value) if isinstance(value, str) else None
    return bool(m) and int(m.group(1)) <= 23 and int(m.group(2)) <= 59


CHECKS = {
    "listed": (lambda v: isinstance(v, bool), "true ou false"),
    "time": (_valid_time, '"real" ou une heure "HH:MM"'),
    "timeSpeed": (lambda v: _number(v, 0, 3600), "un nombre de 0 à 3600"),
    "weather": (lambda v: v in WEATHERS, " ou ".join(f'"{w}"' for w in WEATHERS)),
    "shareStoreMb": (lambda v: _number(v, 16, 1048576, True), "un entier de 16 à 1048576"),
    "shareOutKbps": (lambda v: _number(v, 16, 1048576, True), "un entier de 16 à 1048576"),
    "meetM": (lambda v: _number(v, 0, 20000000), "un nombre de 0 à 20000000"),
}


def validate(body: Any) -> dict[str, Any]:
    """Le contenu voulu de settings.json -> le même, vérifié ; ValueError avec un message sinon. None : clé retirée."""
    if not isinstance(body, dict):
        raise ValueError("Les réglages doivent être un objet JSON")
    out: dict[str, Any] = {}
    for key, value in body.items():
        if key not in CHECKS:
            raise ValueError(f"Réglage inconnu : {key}")
        if value is None:
            continue
        check, expected = CHECKS[key]
        if not check(value):
            raise ValueError(f"{key} doit être {expected}")
        if key in ("shareStoreMb", "shareOutKbps"):
            value = int(value)
        out[key] = value
    return out


_LUA_LINE = re.compile(r"^G\.([A-Z_]+) = (.+?)\s*(?:--.*)?$", re.M)


def _lua_value(raw: str) -> Any:
    raw = raw.strip()
    if raw in ("true", "false"):
        return raw == "true"
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        return raw[1:-1]
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        return None


def defaults(main_lua: str) -> dict[str, Any]:
    """Les valeurs écrites dans main.lua (G.X = ...) : celles d'une clé absente de settings.json."""
    found = {m.group(1): _lua_value(m.group(2)) for m in _LUA_LINE.finditer(main_lua)}
    return {key: found.get(name) for key, name in SETTINGS.items()}


def _as_list(value: Any) -> list:
    # (l'encodeur JSON de BeamMP écrit une table vide en {} : une liste vide)
    if isinstance(value, list):
        return value
    return []


def read_state(inst: InstanceConfig, now: float | None = None) -> dict[str, Any] | None:
    """state.json lu et nettoyé ; None si absent ou illisible. fresh : écrit il y a moins de STATE_FRESH_S."""
    text = read_text(os.path.join(plugin_dir(inst), STATE_FILE))
    try:
        raw = json.loads(text) if text else None
    except ValueError:
        return None
    if not isinstance(raw, dict):
        return None
    now = time.time() if now is None else now
    t = raw.get("t") if isinstance(raw.get("t"), (int, float)) else None
    players = []
    for p in _as_list(raw.get("players")):
        if isinstance(p, dict) and isinstance(p.get("lat"), (int, float)) and isinstance(p.get("lon"), (int, float)):
            players.append({"pid": p.get("pid"), "name": str(p.get("name") or ""), "lat": p["lat"], "lon": p["lon"],
                            "h": p.get("h") if isinstance(p.get("h"), (int, float)) else None,
                            "joined": p.get("joined") if isinstance(p.get("joined"), (int, float)) else None})
    store = raw.get("store") if isinstance(raw.get("store"), dict) else {}
    return {
        "t": t,
        "fresh": t is not None and 0 <= now - t <= STATE_FRESH_S,
        "uptime": raw.get("uptime"),
        "settings": raw.get("settings") if isinstance(raw.get("settings"), dict) else {},
        "warnings": [str(w) for w in _as_list(raw.get("warnings"))],
        "players": players,
        "store": {k: store.get(k) for k in ("mb", "items", "capMb")},     # (en Mo : voir le plugin, G.state)
        "packs": [str(p) for p in _as_list(raw.get("packs"))],
        "stats": raw.get("stats") if isinstance(raw.get("stats"), dict) else {},
    }


def read_settings_file(inst: InstanceConfig) -> tuple[dict[str, Any], str | None]:
    """settings.json -> (son contenu, erreur éventuelle). Absent : ({}, None)."""
    text = read_text(os.path.join(plugin_dir(inst), SETTINGS_FILE))
    if not text.strip():
        return {}, None
    try:
        data = json.loads(text)
    except ValueError:
        return {}, "settings.json n'est pas du JSON valide : le plugin utilise les valeurs de main.lua"
    if not isinstance(data, dict):
        return {}, "settings.json n'est pas un objet JSON : le plugin utilise les valeurs de main.lua"
    return data, None


def write_settings_file(inst: InstanceConfig, settings: dict[str, Any]) -> None:
    # Écriture atomique (write_text) : le plugin relit le fichier toutes les 2 s et une lecture à moitié écrite
    # remettrait les valeurs de main.lua chez tous les joueurs.
    ordered = {k: settings[k] for k in SETTINGS if k in settings}
    write_text(os.path.join(plugin_dir(inst), SETTINGS_FILE), json.dumps(ordered, indent=2) + "\n")


def supports_settings(main_lua: str) -> bool:
    """Le plugin installé lit-il settings.json ? (les versions d'avant le 24/11/2026 l'ignorent)"""
    return "G.SETTINGS_FILE" in main_lua


def _toml_value(config_text: str, key: str) -> str:
    m = re.search(rf"^{key}\s*=\s*(.*?)\s*(?:#.*)?$", config_text, re.M)
    return m.group(1).strip().strip("\"'") if m else ""


# ── Packs compilés (bake/*.bnge) et demandes au plugin ─────────────────────

PACK_MAGIC = b"BNGEBAKE1\n"     # (server/bakepack.py du fork : MAGIC, longueur de l'index sur 8 octets, index JSON)
PACK_INDEX_MAX = 256 * 1024 * 1024
REQUESTS = ("clear-store", "reload-packs")
_pack_cache: dict[str, tuple[tuple[int, float], dict[str, Any]]] = {}


def bake_dir(inst: InstanceConfig) -> str:
    return os.path.join(plugin_dir(inst), "bake")


def valid_pack_name(name: Any) -> str | None:
    base = safe_basename(name)
    if not base or not base.endswith(".bnge") or base.startswith(".") or len(base) > 200:
        return None
    return base if re.fullmatch(r"[\w.\- ]+", base) else None


def read_pack_header(path: str) -> dict[str, Any]:
    """L'en-tête d'un pack : {valid, meta, items} ; valid False (et error) pour un fichier qui n'en est pas un."""
    try:
        with open(path, "rb") as f:
            head = f.read(len(PACK_MAGIC) + 8)
            if len(head) < len(PACK_MAGIC) + 8 or not head.startswith(PACK_MAGIC):
                return {"valid": False, "error": "pas un pack BeamNG.Earth (en-tête BNGEBAKE1 absent)"}
            (n,) = struct.unpack("<Q", head[len(PACK_MAGIC):])
            if n > PACK_INDEX_MAX:
                return {"valid": False, "error": "index trop gros"}
            index = json.loads(f.read(n))
    except (OSError, ValueError):
        return {"valid": False, "error": "index illisible"}
    if not isinstance(index, dict) or not isinstance(index.get("items"), dict):
        return {"valid": False, "error": "index sans items"}
    meta = index.get("meta") if isinstance(index.get("meta"), dict) else {}
    keep = ("bbox", "made", "bake_format", "plans_format", "facts_format", "signature")
    return {"valid": True, "meta": {k: meta.get(k) for k in keep}, "items": len(index["items"])}


def list_packs(inst: InstanceConfig, loaded: list[str] | None = None) -> list[dict[str, Any]]:
    """Les packs de bake/, triés par nom ; loaded : ceux que le plugin sert (state.json), None si inconnu."""
    out = []
    folder = bake_dir(inst)
    try:
        entries = sorted(os.scandir(folder), key=lambda e: e.name)
    except OSError:
        return []
    for e in entries:
        if not e.name.endswith(".bnge") or not e.is_file():
            continue
        st = e.stat()
        key = (st.st_size, st.st_mtime)
        cached = _pack_cache.get(e.path)
        if not cached or cached[0] != key:
            cached = (key, read_pack_header(e.path))
            _pack_cache[e.path] = cached
        out.append({"name": e.name, "size": st.st_size, "mtime": int(st.st_mtime), **cached[1],
                    "loaded": None if loaded is None else e.name in loaded})
    return out


def request(inst: InstanceConfig, name: str) -> None:
    """Dépose une demande pour le plugin (fait sous 2 s, fichier retiré par lui)."""
    if name not in REQUESTS:
        raise ValueError(name)
    write_text(os.path.join(plugin_dir(inst), f"{name}.request"), "")


def pending_requests(inst: InstanceConfig) -> list[str]:
    return [n for n in REQUESTS if os.path.exists(os.path.join(plugin_dir(inst), f"{n}.request"))]


def delete_pack(inst: InstanceConfig, name: str) -> bool:
    base = valid_pack_name(name)
    path = base and resolve_within(bake_dir(inst), base)
    if not path or not os.path.isfile(path):
        return False
    delete_file(path)
    request(inst, "reload-packs")
    return True


def overview(inst: InstanceConfig, config_text: str) -> dict[str, Any]:
    """Tout ce que la page BeamNG.Earth du panel affiche (config_text : ServerConfig.toml ; sa clé n'en sort pas,
    seulement le fait qu'elle soit remplie)."""
    if not installed(inst):
        return {"installed": False}
    main_lua = read_text(os.path.join(plugin_dir(inst), "main.lua"))
    base = defaults(main_lua)
    file, file_error = read_settings_file(inst)
    effective = {**base, **{k: v for k, v in file.items() if k in SETTINGS}}
    state = read_state(inst)
    if state and state["fresh"] and state["settings"]:
        effective = {k: state["settings"].get(k, effective.get(k)) for k in SETTINGS}
    private = _toml_value(config_text, "Private").lower() == "true"
    has_key = bool(_toml_value(config_text, "AuthKey"))
    if private or not has_key:
        listing = "direct"           # sur aucune liste : connexion directe
    elif effective.get("listed") is False:
        listing = "beammp"           # liste publique BeamMP (visible des joueurs sans BeamNG.Earth)
    else:
        listing = "earth"            # liste BeamNG.Earth, cachée de la liste BeamMP par le plugin
    return {
        "installed": True,
        "supportsSettings": supports_settings(main_lua),
        "defaults": base,
        "file": file,
        "fileError": file_error,
        "effective": effective,
        "listing": listing,
        "state": state,
        "packs": list_packs(inst, state["packs"] if state and state["fresh"] else None),
        "pending": pending_requests(inst),
    }
