"""Routes BeamNG.Earth : réglages du plugin serveur (settings.json) et son état (state.json)."""

from __future__ import annotations

import os
import shutil

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.routing import Route

from . import earth, earth_release
from .activity import log_activity
from .files import ensure_dir, read_text
from .routes_dashboard import _single_file
from .security import ApiError, limiter, require_admin
from .web import instance_or_404, json_body, ok

LABELS = {"listed": "liste BeamNG.Earth", "time": "heure", "timeSpeed": "vitesse de l'heure", "weather": "météo",
          "shareStoreMb": "taille du stock", "shareOutKbps": "débit d'envoi", "meetM": "distance de regroupement"}


async def get_earth(request: Request):
    # Admin seulement : l'état contient la position des joueurs connectés.
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    config_text = read_text(inst.beammp.config_path)
    data = await run_in_threadpool(earth.overview, inst, config_text)
    if data.get("installed"):
        data["version"] = await run_in_threadpool(earth_release.installed_version, inst)
    return ok(data)


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


# Un pack d'un département pèse 1 à 2 Go (estimation du 13/11/2026) ; au-delà de 100 Mo, un envoi par un domaine
# derrière le proxy Cloudflare échoue : l'interface propose alors de déposer le fichier dans bake/ (scp) et de
# cliquer « Relire les packs ».
MAX_PACK_BYTES = 8 * 1024 * 1024 * 1024


def _installed_or_404(request: Request):
    inst = instance_or_404(request.path_params["instanceId"])
    if not earth.installed(inst):
        raise ApiError(404, "Plugin BeamNG.Earth absent de Resources/Server")
    return inst


async def clear_store(request: Request):
    user = require_admin(request)
    inst = _installed_or_404(request)
    await run_in_threadpool(earth.request, inst, "clear-store")
    log_activity(inst.id, "earth_store_clear", "BeamNG.Earth : stock partagé vidé", user.get("username"))
    return ok({"requested": True})


async def reload_packs(request: Request):
    require_admin(request)
    inst = _installed_or_404(request)
    await run_in_threadpool(earth.request, inst, "reload-packs")
    return ok({"requested": True})


async def upload_pack(request: Request):
    user = require_admin(request)
    inst = _installed_or_404(request)
    upload, _fields = await _single_file(request, MAX_PACK_BYTES)
    try:
        name = earth.valid_pack_name(os.path.basename(upload.filename or ""))
        if not name:
            raise ApiError(400, "Un pack se termine par .bnge (lettres, chiffres, espaces, . _ - seulement)")
        await upload.seek(0)
        if await upload.read(len(earth.PACK_MAGIC)) != earth.PACK_MAGIC:
            raise ApiError(400, "Ce fichier n'est pas un pack BeamNG.Earth (en-tête BNGEBAKE1 absent)")
        folder = earth.bake_dir(inst)
        ensure_dir(folder)
        dest = os.path.join(folder, name)
        if os.path.exists(dest):
            raise ApiError(409, f"Un pack {name} existe déjà : supprimez-le d'abord")
        tmp = dest + ".part"            # (le plugin ne lit que les .bnge)
        await upload.seek(0)

        def _copy() -> dict:
            try:
                with open(tmp, "wb") as out:
                    shutil.copyfileobj(upload.file, out, 1024 * 1024)
                head = earth.read_pack_header(tmp)
                if head["valid"]:
                    os.replace(tmp, dest)
                return head
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
        head = await run_in_threadpool(_copy)
        if not head["valid"]:
            raise ApiError(400, f"Pack refusé : {head['error']}")
    finally:
        await upload.close()
    await run_in_threadpool(earth.request, inst, "reload-packs")
    log_activity(inst.id, "earth_pack_upload", f"BeamNG.Earth : pack {name} ajouté ({head['items']} éléments)",
                 user.get("username"))
    return ok({"name": name, **head})


async def delete_pack(request: Request):
    user = require_admin(request)
    inst = _installed_or_404(request)
    name = request.path_params["name"]
    if not await run_in_threadpool(earth.delete_pack, inst, name):
        raise ApiError(404, "Pack introuvable")
    log_activity(inst.id, "earth_pack_delete", f"BeamNG.Earth : pack {name} retiré", user.get("username"))
    return ok({"deleted": True})


async def put_helper(request: Request):
    user = require_admin(request)
    inst = _installed_or_404(request)
    try:
        control = earth.validate_helper(await json_body(request))
    except ValueError as err:
        raise ApiError(400, str(err))
    await run_in_threadpool(earth.write_helper, inst, control)
    log_activity(inst.id, "earth_helper",
                 "BeamNG.Earth : assistant de partage " + ("allumé" if control["enabled"] else "éteint")
                 + (f" ({control['procs']} processus)" if control["enabled"] else ""), user.get("username"))
    return ok(control)


# ── Version et mise à jour depuis les releases du fork ──

async def get_release(request: Request):
    require_admin(request)
    inst = _installed_or_404(request)
    return ok(await earth_release.status(inst, force=request.query_params.get("force") == "1"))


async def install_release(request: Request):
    user = require_admin(request)
    inst = _installed_or_404(request)
    limiter.check(request, f"earth-install:{inst.id}", 2, 300)
    try:
        result = await earth_release.install(inst)
    except RuntimeError as err:
        raise ApiError(502, str(err))
    log_activity(inst.id, "earth_update",
                 f"BeamNG.Earth mis à jour : {result['previous'] or '?'} → {result['installed']} (redémarrage nécessaire)",
                 user.get("username"))
    return ok({**result, "needsRestart": True})


async def restore_release(request: Request):
    user = require_admin(request)
    inst = _installed_or_404(request)
    try:
        version = await run_in_threadpool(earth_release.restore_previous, inst)
    except RuntimeError as err:
        raise ApiError(409, str(err))
    log_activity(inst.id, "earth_update", f"BeamNG.Earth : retour à la version {version} (redémarrage nécessaire)",
                 user.get("username"))
    return ok({"installed": version, "needsRestart": True})


routes = [
    Route("/api/i/{instanceId}/earth", get_earth, methods=["GET"]),
    Route("/api/i/{instanceId}/earth/settings", put_earth_settings, methods=["PUT"]),
    Route("/api/i/{instanceId}/earth/store/clear", clear_store, methods=["POST"]),
    Route("/api/i/{instanceId}/earth/packs/reload", reload_packs, methods=["POST"]),
    Route("/api/i/{instanceId}/earth/packs/upload", upload_pack, methods=["POST"]),
    Route("/api/i/{instanceId}/earth/packs/{name}", delete_pack, methods=["DELETE"]),
    Route("/api/i/{instanceId}/earth/helper", put_helper, methods=["PUT"]),
    Route("/api/i/{instanceId}/earth/release", get_release, methods=["GET"]),
    Route("/api/i/{instanceId}/earth/release/install", install_release, methods=["POST"]),
    Route("/api/i/{instanceId}/earth/release/restore", restore_release, methods=["POST"]),
]
