"""Routes publiques : instances, statut, flux SSE, mods actifs, activité."""

from __future__ import annotations

import asyncio
import json
import time

from starlette.requests import Request
from starlette.responses import StreamingResponse
from starlette.routing import Route

from . import config as C
from .activity import get_activity
from .db import db
from .logwatch import server_started_at
from .status import get_server_status, offline_status
from .web import ok

PANEL_STARTED = time.time()
SSE_INTERVAL_S = 10


def uptime_ms(instance_id: str) -> int:
    # Uptime du serveur BeamMP (dernier « ALL SYSTEMS STARTED » du journal) ;
    # à défaut celui du panel, comme le faisait la v2.
    started = server_started_at(instance_id) or PANEL_STARTED
    return max(0, int((time.time() - started) * 1000))


async def status_payload(instance_id: str) -> dict:
    inst = C.get_instance(instance_id)
    if not inst:
        return offline_status()
    status = await get_server_status(inst)
    return {**status, "uptimeMs": uptime_ms(inst.id)}


def active_mods(instance_id: str) -> list[dict]:
    return db().all(
        "SELECT id, name, type, image, description, map_id FROM mods "
        "WHERE instance_id = ? AND active = 1 ORDER BY type, name", [instance_id])


async def instances(request: Request):
    return ok([{"id": i.id, "name": i.name, "canRestart": i.agent is not None} for i in C.config.instances])


async def instance_status(request: Request):
    return ok(await status_payload(request.path_params["instanceId"]))


def _sse(instance_id: str, request: Request) -> StreamingResponse:
    async def gen():
        while True:
            payload = await status_payload(instance_id)
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
            for _ in range(SSE_INTERVAL_S * 2):
                if await request.is_disconnected():
                    return
                await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                                      "X-Accel-Buffering": "no"})


async def instance_stream(request: Request):
    return _sse(request.path_params["instanceId"], request)


async def instance_active_mods(request: Request):
    return ok(active_mods(request.path_params["instanceId"]))


async def instance_activity(request: Request):
    return ok(get_activity(request.path_params["instanceId"], 15))


async def info(request: Request):
    return ok({"discordUrl": C.config.discord.server_url, "kofiUrl": C.config.kofi_url,
               "serverDescription": C.config.server_description})


# Anciennes routes sans instance → première instance (compatibilité).

async def legacy_status(request: Request):
    return ok(await status_payload(C.config.instances[0].id))


async def legacy_stream(request: Request):
    return _sse(C.config.instances[0].id, request)


async def legacy_active_mods(request: Request):
    return ok(active_mods(C.config.instances[0].id))


async def legacy_activity(request: Request):
    return ok(get_activity(C.config.instances[0].id, 15))


routes = [
    Route("/api/instances", instances),
    Route("/api/i/{instanceId}/status", instance_status),
    Route("/api/i/{instanceId}/stream", instance_stream),
    Route("/api/i/{instanceId}/mods/active", instance_active_mods),
    Route("/api/i/{instanceId}/activity", instance_activity),
    Route("/api/info", info),
    Route("/api/status", legacy_status),
    Route("/api/stream", legacy_stream),
    Route("/api/mods/active", legacy_active_mods),
    Route("/api/activity", legacy_activity),
]
