"""Statut du serveur BeamMP, en cascade du plus fiable au moins fiable.

0. Paquet « I » sur le port de jeu (nouveau en v3) : le serveur renvoie en
   local le même JSON que son heartbeat (joueurs, carte, mods, nom), sans
   la clé d'auth, même quand il est privé. Réponse immédiate, aucun délai.
1. Liste publique BeamMP (backend.beammp.com), si IP et port configurés.
2. API HTTP locale optionnelle (plugin tiers).
3. Repli sur le suivi des arrivées et départs lus dans le journal.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import struct
import time
from typing import Any

import httpx

from .config import InstanceConfig
from .db import db
from .files import read_text

log = logging.getLogger("beammp_panel.status")

BEAMMP_API = "https://backend.beammp.com/servers-info"
SERVER_LIST_TTL_S = 30
CACHE_TTL_S = 15
INFO_TIMEOUT_S = 1.5

_server_list: list[dict[str, Any]] | None = None
_server_list_ts = 0.0
_caches: dict[str, tuple[float, dict[str, Any]]] = {}
_locks: dict[str, asyncio.Lock] = {}

# ── Suivi des joueurs par le journal (repli) ───────────────────

_online: dict[str, set[str]] = {}
_last_activity: dict[str, float] = {}


def _players(instance_id: str) -> set[str]:
    return _online.setdefault(instance_id, set())


def player_joined(instance_id: str, username: str) -> None:
    _players(instance_id).add(username)
    _last_activity[instance_id] = time.time()
    invalidate_cache(instance_id)


def player_left(instance_id: str, username: str) -> None:
    _players(instance_id).discard(username)
    _last_activity[instance_id] = time.time()
    invalidate_cache(instance_id)


def mark_server_alive(instance_id: str) -> None:
    # Un serveur privé fraîchement redémarré n'a encore vu personne : sans
    # ce signal, le repli le dirait « hors ligne » alors qu'il tourne.
    _last_activity[instance_id] = time.time()
    invalidate_cache(instance_id)


def online_players(instance_id: str) -> list[str]:
    return sorted(_players(instance_id))


def invalidate_cache(instance_id: str) -> None:
    _caches.pop(instance_id, None)


def reset() -> None:
    global _server_list, _server_list_ts
    _server_list, _server_list_ts = None, 0.0
    _caches.clear()
    _online.clear()
    _last_activity.clear()
    _locks.clear()


# ── Utilitaires de format ──────────────────────────────────────

def parse_players(playerslist: str) -> list[str]:
    if not playerslist:
        return []
    # BeamMP sépare par « ; » ou « , » selon les versions.
    return [p.strip() for p in re.split(r"[;,]", playerslist) if p.strip()]


def parse_modlist(modlist: str) -> list[str]:
    if not modlist:
        return []
    return [m.lstrip("/").strip() for m in modlist.split(";") if m.strip().lstrip("/")]


def clean_sdesc(sdesc: str) -> str:
    # Texte enrichi BeamMP : ^p = saut de ligne, ^0-^9 = couleurs, ^l/^o… = styles.
    text = (sdesc or "").replace("^p", "\n")
    return re.sub(r"\^[0-9a-fA-Fl-or]", "", text).strip()


def _active_map(instance_id: str) -> dict[str, Any] | None:
    try:
        return db().one(
            "SELECT map_id, name FROM mods WHERE instance_id = ? AND type = 'map' AND active = 1 LIMIT 1",
            [instance_id])
    except Exception:  # base indisponible : le statut doit répondre quand même
        return None


def _config_fallback(inst: InstanceConfig) -> tuple[int, str, bool]:
    content = read_text(inst.beammp.config_path)
    max_m = re.search(r"^MaxPlayers\s*=\s*(\d+)", content, re.M)
    name_m = re.search(r"^Name\s*=\s*[\"']?(.+?)[\"']?\s*$", content, re.M)
    priv_m = re.search(r"^Private\s*=\s*[\"']?(true|false)[\"']?", content, re.M | re.I)
    return (int(max_m.group(1)) if max_m else 0,
            name_m.group(1).strip() if name_m else inst.name,
            bool(priv_m and priv_m.group(1).lower() == "true"))


# ── Niveau 0 : paquet I ────────────────────────────────────────

async def query_info_packet(host: str, port: int, timeout: float = INFO_TIMEOUT_S) -> dict[str, Any] | None:
    """Envoie l'octet « I » et lit la réponse : longueur (int32 LE) puis JSON."""
    writer = None
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
        writer.write(b"I")
        await writer.drain()
        header = await asyncio.wait_for(reader.readexactly(4), timeout)
        (size,) = struct.unpack("<i", header)
        if size <= 0 or size > 1_000_000:
            return None  # serveur pas encore passé par son premier heartbeat, ou réponse aberrante
        body = await asyncio.wait_for(reader.readexactly(size), timeout)
        data = json.loads(body.decode("utf-8", errors="replace"))
        return data if isinstance(data, dict) else None
    except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, ValueError, struct.error):
        return None
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


async def _level0(inst: InstanceConfig) -> dict[str, Any] | None:
    port = _int(inst.server_port) or 30814
    host = inst.beammp.info_host
    if not host:
        return None
    info = await query_info_packet(host, port)
    if not info:
        return None
    players = parse_players(str(info.get("playerslist", "")))
    active = _active_map(inst.id)
    return {
        "online": True,
        "playerCount": _int(info.get("players"), len(players)),
        "maxPlayers": _int(info.get("maxplayers")),
        "players": players,
        "map": active["map_id"] if active else info.get("map", ""),
        "mapName": active["name"] if active else info.get("map", ""),
        "serverName": info.get("name") or inst.name,
        "version": info.get("version"),
        "sdesc": clean_sdesc(str(info.get("desc", ""))),
        "modlist": parse_modlist(str(info.get("modlist", ""))),
        "modsTotalSize": _int(info.get("modstotalsize")),
        "source": "local",
    }


# ── Niveau 1 : liste publique ──────────────────────────────────

async def _fetch_server_list() -> list[dict[str, Any]]:
    global _server_list, _server_list_ts
    now = time.monotonic()
    if _server_list is not None and now - _server_list_ts < SERVER_LIST_TTL_S:
        return _server_list
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.get(BEAMMP_API)
            res.raise_for_status()
            data = res.json()
            _server_list = data if isinstance(data, list) else []
            _server_list_ts = now
    except (httpx.HTTPError, ValueError) as err:
        log.warning("Liste publique BeamMP indisponible : %s", err)
    return _server_list or []


async def _fetch_status(inst: InstanceConfig) -> dict[str, Any]:
    data = await _level0(inst)
    if data:
        return data

    public_says_offline = False
    if inst.server_ip and inst.server_port:
        servers = await _fetch_server_list()
        server = next((s for s in servers if s.get("ip") == inst.server_ip
                       and str(s.get("port")) == str(inst.server_port)), None)
        if server:
            players = parse_players(server.get("playerslist", ""))
            active = _active_map(inst.id)
            return {
                "online": True,
                "playerCount": _int(server.get("players"), len(players)) or len(players),
                "maxPlayers": _int(server.get("maxplayers")),
                "players": players,
                "map": active["map_id"] if active else server.get("map", ""),
                "mapName": active["name"] if active else server.get("map", ""),
                "serverName": server.get("sname", ""),
                "version": server.get("version"),
                "location": server.get("location"),
                "sdesc": clean_sdesc(server.get("sdesc", "")),
                "modlist": parse_modlist(server.get("modlist", "")),
                "modsTotalSize": _int(server.get("modstotalsize")),
                "source": "public",
            }
        # Absent de la liste : à lui seul ce n'est pas une preuve (serveur
        # privé, tout juste démarré, glitch). Sert seulement de dernier mot.
        if servers:
            public_says_offline = True

    base_url = f"http://{inst.beammp.api_host}:{inst.beammp.api_port}"
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            res = await client.get(f"{base_url}/api/players")
            if res.status_code < 400:
                api_players = res.json()
                info_res = await client.get(f"{base_url}/api/status")
                info = info_res.json() if info_res.status_code < 400 else {}
                active = _active_map(inst.id)
                return {
                    "online": True,
                    "playerCount": len(api_players),
                    "maxPlayers": info.get("maxplayers", 0),
                    "players": api_players,
                    "map": active["map_id"] if active else info.get("map", ""),
                    "mapName": active["name"] if active else info.get("map", ""),
                    "serverName": info.get("name", inst.name),
                    "source": "plugin",
                }
    except (httpx.HTTPError, ValueError, AttributeError):
        pass

    players = online_players(inst.id)
    active = _active_map(inst.id)
    max_players, server_name, is_private = _config_fallback(inst)
    recent = time.time() - _last_activity.get(inst.id, 0) < 5 * 60
    # Un serveur privé n'apparaît jamais dans la liste publique : son absence
    # ne doit pas l'emporter sur le signal du journal.
    online = (is_private or not public_says_offline) and (bool(players) or recent)
    return {
        "online": online,
        "playerCount": len(players),
        "maxPlayers": max_players,
        "players": players,
        "map": active["map_id"] if active else "",
        "mapName": active["name"] if active else "",
        "serverName": server_name,
        "source": "logs",
    }


async def get_server_status(inst: InstanceConfig) -> dict[str, Any]:
    cached = _caches.get(inst.id)
    if cached and time.monotonic() - cached[0] < CACHE_TTL_S:
        return cached[1]
    # Un seul calcul à la fois par instance : plusieurs flux SSE qui ratent
    # le cache au même instant attendent le même résultat au lieu de
    # relancer chacun toute la cascade.
    lock = _locks.setdefault(inst.id, asyncio.Lock())
    async with lock:
        cached = _caches.get(inst.id)
        if cached and time.monotonic() - cached[0] < CACHE_TTL_S:
            return cached[1]
        data = await _fetch_status(inst)
        _caches[inst.id] = (time.monotonic(), data)
        return data


def offline_status() -> dict[str, Any]:
    return {"online": False, "playerCount": 0, "maxPlayers": 0, "players": [],
            "map": "", "mapName": "", "serverName": "", "uptimeMs": 0}
