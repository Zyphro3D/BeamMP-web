"""Configs pré-établies : un jeu de mods/véhicules + une carte, appliqués en un clic.

« Appliquer » met l'état actif exactement à ce que décrit la config
(désactive tout le reste), active la carte, puis tente un redémarrage. Les
mods supprimés depuis la sauvegarde sont ignorés : une config ne devient
jamais inutilisable parce qu'un de ses mods a disparu.
"""

from __future__ import annotations

import sqlite3

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.routing import Route

from .activity import log_activity
from .agent import restart_via_agent
from .db import db, dumps, now_iso
from .discord import send_discord_notification
from .modstate import activate_map, set_mod_active
from .security import ApiError, limiter, require_admin, require_auth
from .status import invalidate_cache
from .web import instance_or_404, int_param, json_body, ok


def _validated(body: dict) -> tuple[str, list[int], str | None]:
    name = body.get("name")
    mod_ids = body.get("mod_ids")
    map_id = body.get("map_id") or None
    if not isinstance(name, str) or not name.strip():
        raise ApiError(400, "name is required")
    if not isinstance(mod_ids, list) or any(not isinstance(i, int) or isinstance(i, bool) for i in mod_ids):
        raise ApiError(400, "mod_ids must be an array of integers")
    if map_id is not None and not isinstance(map_id, str):
        raise ApiError(400, "map_id must be a string")
    return name.strip(), mod_ids, map_id


async def list_presets(request: Request):
    require_auth(request)
    inst = instance_or_404(request.path_params["instanceId"])
    return ok(db().all("SELECT * FROM config_presets WHERE instance_id = ? ORDER BY name", [inst.id]))


async def create_preset(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    name, mod_ids, map_id = _validated(await json_body(request))
    try:
        cur = db().run("INSERT INTO config_presets (instance_id, name, mod_ids, map_id, created_at) VALUES (?, ?, ?, ?, ?)",
                       [inst.id, name, dumps(mod_ids), map_id, now_iso()])
    except sqlite3.IntegrityError:
        raise ApiError(409, f'Une config nommée "{name}" existe déjà')
    return ok(db().one("SELECT * FROM config_presets WHERE id = ?", [cur.lastrowid]))


async def update_preset(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    preset_id = int_param(request, "id")
    name, mod_ids, map_id = _validated(await json_body(request))
    try:
        cur = db().run("UPDATE config_presets SET name = ?, mod_ids = ?, map_id = ? WHERE id = ? AND instance_id = ?",
                       [name, dumps(mod_ids), map_id, preset_id, inst.id])
    except sqlite3.IntegrityError:
        raise ApiError(409, f'Une config nommée "{name}" existe déjà')
    if cur.rowcount == 0:
        raise ApiError(404, "Not found")
    return ok(db().one("SELECT * FROM config_presets WHERE id = ?", [preset_id]))


async def delete_preset(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    cur = db().run("DELETE FROM config_presets WHERE id = ? AND instance_id = ?", [int_param(request, "id"), inst.id])
    if cur.rowcount == 0:
        raise ApiError(404, "Not found")
    return ok({"deleted": True})


async def apply_preset(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    limiter.check(request, f"apply:{inst.id}", 3, 60)  # peut redémarrer le serveur
    preset = db().one("SELECT * FROM config_presets WHERE id = ? AND instance_id = ?",
                      [int_param(request, "id"), inst.id])
    if not preset:
        raise ApiError(404, "Not found")

    existing = [r["id"] for r in db().all("SELECT id FROM mods WHERE instance_id = ? AND type IN ('mod', 'vehicle')",
                                          [inst.id])]
    wanted = {i for i in (preset["mod_ids"] or []) if i in existing}
    missing = len(preset["mod_ids"] or []) - len(wanted)

    def _apply_mods() -> None:
        for mod_id in existing:
            set_mod_active(inst, mod_id, mod_id in wanted)
    await run_in_threadpool(_apply_mods)

    map_applied = map_error = None
    if preset["map_id"]:
        good, result = await run_in_threadpool(activate_map, inst, preset["map_id"])
        if good:
            map_applied = str(result["name"])
        else:
            map_error = result

    invalidate_cache(inst.id)
    log_activity(inst.id, "preset_applied", f"Config appliquée : {preset['name']}")
    suffix = f" — carte : **{map_applied}**" if map_applied else ""
    await send_discord_notification("preset_applied", f"Config **{preset['name']}** appliquée{suffix}")

    restarted, restart_error = False, None
    if inst.agent:
        restarted, restart_error = await restart_via_agent(inst)
    return ok({"applied": preset["name"], "modsActivated": len(wanted), "modsMissing": missing,
               "mapApplied": map_applied, "mapError": map_error, "restarted": restarted,
               "restartError": restart_error, "needsRestart": not restarted})


routes = [
    Route("/api/i/{instanceId}/presets", list_presets, methods=["GET"]),
    Route("/api/i/{instanceId}/presets", create_preset, methods=["POST"]),
    Route("/api/i/{instanceId}/presets/{id}", update_preset, methods=["PUT"]),
    Route("/api/i/{instanceId}/presets/{id}", delete_preset, methods=["DELETE"]),
    Route("/api/i/{instanceId}/presets/{id}/apply", apply_preset, methods=["POST"]),
]
