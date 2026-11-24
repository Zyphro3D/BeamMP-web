"""Routes BeamNG.Earth : réglages du plugin serveur (settings.json) et son état (state.json)."""

from __future__ import annotations

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.routing import Route

from . import earth
from .activity import log_activity
from .files import read_text
from .security import ApiError, require_admin
from .web import instance_or_404, json_body, ok

LABELS = {"listed": "liste BeamNG.Earth", "time": "heure", "timeSpeed": "vitesse de l'heure", "weather": "météo",
          "shareStoreMb": "taille du stock", "shareOutKbps": "débit d'envoi", "meetM": "distance de regroupement"}


async def get_earth(request: Request):
    # Admin seulement : l'état contient la position des joueurs connectés.
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    config_text = read_text(inst.beammp.config_path)
    return ok(await run_in_threadpool(earth.overview, inst, config_text))


async def put_earth_settings(request: Request):
    user = require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    if not earth.installed(inst):
        raise ApiError(404, "Plugin BeamNG.Earth absent de Resources/Server")
    body = await json_body(request)
    try:
        settings = earth.validate(body)
    except ValueError as err:
        raise ApiError(400, str(err))
    before, _ = earth.read_settings_file(inst)
    await run_in_threadpool(earth.write_settings_file, inst, settings)
    changed = sorted(k for k in earth.SETTINGS if before.get(k) != settings.get(k))
    if changed:
        log_activity(inst.id, "earth_settings",
                     "BeamNG.Earth : " + ", ".join(LABELS[k] for k in changed) + " modifié(s)", user.get("username"))
    return ok({"file": settings, "changed": changed})


routes = [
    Route("/api/i/{instanceId}/earth", get_earth, methods=["GET"]),
    Route("/api/i/{instanceId}/earth/settings", put_earth_settings, methods=["PUT"]),
]
