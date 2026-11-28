"""Serveurs du panel : liste, bouton « Ajouter un serveur », retrait (dossier archivé).

L'ajout et le retrait se font à chaud : le serveur ajouté démarre (conteneur « jeu » sous Linux,
supervision locale sous Windows) et son journal est suivi, sans toucher aux autres serveurs.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

from starlette.requests import Request
from starlette.routing import Route

from . import config as C
from . import servers, supervisor, updater
from .activity import log_activity
from .config import InstanceConfig
from .security import ApiError, require_admin, require_superadmin
from .web import instance_or_404, json_body, ok

log = logging.getLogger("beammp_panel.routes_servers")

# Fournis par app.py : suivi du journal d'un serveur ajouté ou retiré.
watch_instance: Callable[[InstanceConfig], None] | None = None
unwatch_instance: Callable[[str], Awaitable[None]] | None = None

_lock = asyncio.Lock()


def _base() -> InstanceConfig:
    return C.config.instances[0]


async def _describe(inst: InstanceConfig) -> dict:
    sp = supervisor.get(inst)
    state = await sp.fetch_state() if sp else {}
    return {"id": inst.id, "name": inst.name, "port": int(inst.server_port) if str(inst.server_port).isdigit() else None,
            "origin": inst.origin, "removable": inst.origin == "panel", "managed": bool(sp),
            "running": bool(state.get("running")), "wanted": bool(state.get("wanted")),
            "error": state.get("error") or "", "unreachable": bool(state.get("unreachable"))}


async def list_servers(request: Request):
    require_admin(request)
    base = _base()
    can, why = servers.can_add(base)
    # Installation Docker encore sur le service systemd (agent) : bascule proposée, sauf si une demande est en
    # attente. Un refus d'install.sh s'affiche au-dessus du bouton : une fois la cause corrigée, on réessaie.
    refusal = "" if can else updater.runner_refusal()
    can_switch = (not can and bool(base.agent) and len(C.config.instances) == 1 and updater.docker_mode()
                  and not updater.host_status()["pending"])
    items = await asyncio.gather(*(_describe(i) for i in C.config.instances))
    return ok({"canAdd": can, "reason": refusal or why, "refusal": refusal, "canSwitch": can_switch,
               "switchPending": not can and updater.host_status()["pending"],
               "nextPort": servers.next_port(C.config.instances), "servers": list(items)})


async def switch_to_runner(request: Request):
    user = require_superadmin(request)
    if servers.can_add(_base())[0]:
        raise ApiError(409, "Le serveur tourne déjà dans le conteneur « jeu »")
    try:
        await asyncio.to_thread(updater.request_runner_switch)
    except (ValueError, OSError) as err:
        raise ApiError(400, str(err))
    log_activity(_base().id, "server_switch", "Passage au conteneur « jeu » demandé", user=user.get("username"))
    return ok({"requested": True})


async def add_server(request: Request):
    user = require_superadmin(request)
    body = await json_body(request)
    base = _base()
    can, why = servers.can_add(base)
    if not can:
        raise ApiError(409, why)
    async with _lock:
        try:
            entry = await asyncio.to_thread(servers.create, body.get("name"), body.get("port"),
                                            body.get("authKey"), C.config.instances)
        except ValueError as err:
            raise ApiError(400, str(err))
        inst = servers.instance_for(entry, base, base.runner)
        C.config.instances.append(inst)
    if watch_instance:
        watch_instance(inst)
    started, error = True, ""
    sp = supervisor.get(inst)
    if sp:
        try:
            await sp.start()
        except OSError as err:
            started, error = False, str(err)
    log_activity(inst.id, "server_added", f"Serveur ajouté · {inst.name}",
                 params={"name": inst.name, "port": entry["port"]}, user=user.get("username"))
    return ok({"server": await _describe(inst), "started": started, "error": error}, 201)


async def remove_server(request: Request):
    user = require_superadmin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    if inst.origin != "panel":
        raise ApiError(400, "Ce serveur vient de l'installation : il ne se retire pas depuis le panel")
    async with _lock:
        sp = supervisor.get(inst)
        try:
            if isinstance(sp, supervisor.RemoteServer):
                await sp.forget()          # arrêté AVANT de déplacer son dossier
            else:
                await supervisor.stop_one(inst.id)
        except OSError as err:
            raise ApiError(502, f"Arrêt du serveur impossible, rien n'est archivé : {err}")
        if unwatch_instance:
            await unwatch_instance(inst.id)
        try:
            dest = await asyncio.to_thread(servers.archive, inst.id)
        except (OSError, ValueError) as err:
            raise ApiError(500, f"Archivage impossible : {err}")
        C.config.instances[:] = [i for i in C.config.instances if i.id != inst.id]
    log_activity(_base().id, "server_removed", f"Serveur retiré · {inst.name}",
                 params={"name": inst.name}, user=user.get("username"))
    return ok({"archived": dest})


routes = [
    Route("/api/admin/servers", list_servers, methods=["GET"]),
    Route("/api/admin/servers", add_server, methods=["POST"]),
    Route("/api/admin/servers/switch", switch_to_runner, methods=["POST"]),
    Route("/api/admin/servers/{instanceId}", remove_server, methods=["DELETE"]),
]
