"""Routes du tableau de bord : mods, images, cartes, config, journaux, serveur."""

from __future__ import annotations

import os
import re
import shutil
import sqlite3
from pathlib import Path

from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.routing import Route

from . import config as C
from .activity import log_activity
from .agent import can_restart, check_for_update, restart_via_agent, update_via_agent
from .analyzer import analyze_upload, to_webp
from .db import db, dumps, now_iso
from .discord import notify_map_change, notify_mod_upload, notify_restart, notify_update
from .files import delete_file, ensure_dir, read_text, tail_lines, write_text
from .logwatch import active_alerts
from .modstate import (ALLOWED_CONFIG_KEYS, activate_map, format_toml_value, valid_map_id, read_config_entries,
                       set_mod_active, set_toml_key)
from .security import ApiError, limiter, require_admin, require_auth
from .status import invalidate_cache
from .web import instance_or_404, int_param, json_body, ok

MAX_UPLOAD_BYTES = 500 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
ZIP_MAGIC = b"PK\x03\x04"


async def _single_file(request: Request, max_bytes: int) -> tuple[UploadFile, dict[str, str]]:
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > max_bytes + 1024 * 1024:
        raise ApiError(413, f"Fichier trop gros (maximum {max_bytes // (1024 * 1024)} Mo)")
    try:
        # python-multipart écrit les fichiers sur disque au-delà de 1 Mo :
        # un zip de 400 Mo ne passe plus par la RAM comme dans la v2.
        form = await request.form(max_files=1, max_fields=20)
    except Exception:
        raise ApiError(400, "Formulaire multipart invalide")
    upload = next((v for v in form.values() if isinstance(v, UploadFile)), None)
    if upload is None:
        raise ApiError(400, "No file")
    fields = {k: v for k, v in form.items() if isinstance(v, str)}
    return upload, fields


# ── Mods ───────────────────────────────────────────────────────

async def list_mods(request: Request):
    require_auth(request)
    return ok(db().all("SELECT * FROM mods WHERE instance_id = ? ORDER BY type, name",
                       [request.path_params["instanceId"]]))


async def upload_mod(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    upload, fields = await _single_file(request, MAX_UPLOAD_BYTES)
    try:
        name = (fields.get("name") or "").strip()
        type_ = fields.get("type") or ""
        desc = fields.get("description") or ""
        map_id = fields.get("map_id") or None
        if not name or type_ not in ("mod", "vehicle", "map"):
            raise ApiError(400, "name and type are required")
        if map_id is not None and not valid_map_id(map_id):
            raise ApiError(400, "map_id invalide (lettres, chiffres, . _ - seulement)")

        filename = os.path.basename(upload.filename or "")
        if os.path.splitext(filename)[1].lower() not in (".zip", ".pak"):
            raise ApiError(400, "Seuls les fichiers .zip et .pak sont autorisés")
        await upload.seek(0)
        if await upload.read(4) != ZIP_MAGIC:
            raise ApiError(400, "Fichier invalide : le contenu ne correspond pas à une archive ZIP/PAK valide")

        safe_filename = re.sub(r"[^a-zA-Z0-9._-]", "_", filename)
        if not safe_filename or safe_filename.startswith("."):
            raise ApiError(400, "Nom de fichier invalide")
        # Vérifier la base AVANT d'écrire : écrire d'abord écraserait le
        # fichier d'un mod existant en cas de collision de nom.
        if db().one("SELECT id FROM mods WHERE instance_id = ? AND filename = ?", [inst.id, safe_filename]):
            raise ApiError(409, f'Un mod avec le fichier "{safe_filename}" existe déjà')

        # Une seule carte active : une nouvelle carte arrive inactive s'il y
        # en a déjà une — et son zip va alors dans inactive_map/, pas dans
        # Client/ (la v2 l'y mettait quand même : les joueurs la téléchargeaient).
        start_active = True
        if type_ == "map" and db().one(
                "SELECT id FROM mods WHERE instance_id = ? AND type = 'map' AND active = 1 LIMIT 1", [inst.id]):
            start_active = False
        sub = "Client" if start_active or type_ != "map" else "inactive_map"
        dest_dir = os.path.join(inst.beammp.resources_path, sub)
        ensure_dir(dest_dir)
        dest = os.path.join(dest_dir, safe_filename)
        tmp = dest + ".part"
        await upload.seek(0)

        def _copy() -> None:
            with open(tmp, "wb") as out:
                shutil.copyfileobj(upload.file, out, 1024 * 1024)
            os.replace(tmp, dest)
        try:
            await run_in_threadpool(_copy)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    finally:
        await upload.close()

    image, metadata = await run_in_threadpool(
        analyze_upload, dest, type_, C.config.images_path, Path(safe_filename).stem, inst.id)
    desc_json = dumps({"fr": desc}) if desc else None
    try:
        cur = db().run(
            "INSERT INTO mods (instance_id, name, type, filename, description, active, map_id, image, metadata, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [inst.id, name, type_, safe_filename, desc_json, int(start_active), map_id, image, dumps(metadata), now_iso()])
    except sqlite3.IntegrityError:
        raise ApiError(409, f'Un mod avec le fichier "{safe_filename}" existe déjà')
    log_activity(inst.id, "mod_upload", f"Mod uploadé · {name}")
    await notify_mod_upload(inst, name, type_, os.path.getsize(dest) if os.path.exists(dest) else 0, bool(start_active))
    return ok(db().one("SELECT * FROM mods WHERE id = ?", [cur.lastrowid]))


async def toggle_mod(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    mod_id = int_param(request, "id")
    row = db().one("SELECT type, active FROM mods WHERE id = ? AND instance_id = ?", [mod_id, inst.id])
    if not row:
        raise ApiError(404, "Not found")
    # Les cartes ont un seul emplacement « actif », géré par /maps/activate.
    if row["type"] == "map":
        raise ApiError(400, "Use /maps/activate to change the active map instead of toggling it")
    mod = await run_in_threadpool(set_mod_active, inst, mod_id, not row["active"])
    if not mod:
        raise ApiError(404, "Not found")
    return ok({**mod, "needsRestart": True})


async def delete_mod(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    mod_id = int_param(request, "id")
    mod = db().one("SELECT * FROM mods WHERE id = ? AND instance_id = ?", [mod_id, inst.id])
    if not mod:
        raise ApiError(404, "Not found")
    if mod["is_official"]:
        raise ApiError(403, "Cannot delete an official mod/map")
    db().run("DELETE FROM mods WHERE id = ? AND instance_id = ?", [mod_id, inst.id])
    for sub in ("Client", "inactive_mod", "inactive_map"):
        delete_file(os.path.join(inst.beammp.resources_path, sub, mod["filename"]))
    if mod["image"]:
        delete_file(os.path.join(C.config.images_path, mod["image"]))
    return ok({"deleted": True})


async def toggle_official(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    mod_id = int_param(request, "id")
    cur = db().run("UPDATE mods SET is_official = NOT is_official WHERE id = ? AND instance_id = ?", [mod_id, inst.id])
    if cur.rowcount == 0:
        raise ApiError(404, "Not found")
    return ok(db().one("SELECT * FROM mods WHERE id = ?", [mod_id]))


async def patch_description(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    mod_id = int_param(request, "id")
    body = await json_body(request)
    lang = body.get("lang")
    text = body.get("text") or ""
    if not isinstance(lang, str) or not re.fullmatch(r"[a-z]{2,5}", lang):
        raise ApiError(400, "lang must be a 2-5 char code (fr, en, de…)")
    if not isinstance(text, str):
        raise ApiError(400, "text must be a string")
    mod = db().one("SELECT description FROM mods WHERE id = ? AND instance_id = ?", [mod_id, inst.id])
    if not mod:
        raise ApiError(404, "Not found")
    desc = mod["description"] if isinstance(mod["description"], dict) else {}
    if text == "":
        desc.pop(lang, None)
    else:
        desc[lang] = text
    db().run("UPDATE mods SET description = ? WHERE id = ?", [dumps(desc), mod_id])
    return ok(db().one("SELECT * FROM mods WHERE id = ?", [mod_id]))


async def upload_image(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    mod_id = int_param(request, "id")  # sert à construire un chemin : forcé numérique
    upload, _ = await _single_file(request, MAX_IMAGE_BYTES)
    try:
        data = await upload.read(MAX_IMAGE_BYTES + 1)
    finally:
        await upload.close()
    if len(data) > MAX_IMAGE_BYTES:
        raise ApiError(413, "Image trop grosse")
    try:
        webp = await run_in_threadpool(to_webp, data, (400, 400), 80)
    except Exception:
        raise ApiError(400, "Fichier image invalide")
    mod = db().one("SELECT image FROM mods WHERE id = ? AND instance_id = ?", [mod_id, inst.id])
    if not mod:
        raise ApiError(404, "Not found")
    img_name = f"{mod_id}.webp"
    ensure_dir(C.config.images_path)
    Path(C.config.images_path, img_name).write_bytes(webp)
    # L'ancienne image extraite du zip devenait orpheline dans la v2.
    old = mod["image"]
    if old and old != img_name:
        delete_file(os.path.join(C.config.images_path, old))
    db().run("UPDATE mods SET image = ? WHERE id = ?", [img_name, mod_id])
    return ok({"image": img_name})


# ── Cartes ─────────────────────────────────────────────────────

async def maps_activate(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    body = await json_body(request)
    map_id = body.get("map_id")
    if not isinstance(map_id, str) or not map_id:
        raise ApiError(400, "map_id is required")
    previous = db().one("SELECT name FROM mods WHERE instance_id = ? AND type = 'map' AND active = 1 LIMIT 1", [inst.id])
    good, result = await run_in_threadpool(activate_map, inst, map_id)
    if not good:
        raise ApiError(404, result)
    invalidate_cache(inst.id)
    log_activity(inst.id, "map_change", f"Carte changée → {result['name']}")
    await notify_map_change(inst, result, previous["name"] if previous else None)
    return ok({"activated": map_id, "needsRestart": True})


# ── Configuration ──────────────────────────────────────────────

async def get_config(request: Request):
    require_auth(request)
    inst = instance_or_404(request.path_params["instanceId"])
    content = read_text(inst.beammp.config_path)
    if not content:
        raise ApiError(404, "ServerConfig.toml not found or empty")
    return ok(read_config_entries(content))


async def patch_config(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    body = await json_body(request)
    for key in body:
        if key not in ALLOWED_CONFIG_KEYS:
            raise ApiError(400, f"Clé de configuration non autorisée : {key}")
    content = read_text(inst.beammp.config_path)
    if not content:
        raise ApiError(404, "ServerConfig.toml not found")
    for key, raw in body.items():
        value = raw if isinstance(raw, str) else ("true" if raw is True else "false" if raw is False else str(raw))
        # Retirer les fins de ligne : sinon une valeur pourrait injecter une
        # ligne TOML entière (une fausse AuthKey) malgré la liste blanche.
        value = re.sub(r"[\r\n  ]", "", value)
        content = set_toml_key(content, key, format_toml_value(key, value))
    write_text(inst.beammp.config_path, content)
    invalidate_cache(inst.id)
    return ok({"updated": True})


# ── Journaux et alertes ────────────────────────────────────────

async def get_logs(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    raw = request.query_params.get("lines", "100")
    n = int(raw) if raw.isdigit() and int(raw) > 0 else 100
    n = min(n, 5000)
    lines = await run_in_threadpool(tail_lines, inst.beammp.log_path, n)
    return ok({"lines": lines})


async def get_alerts(request: Request):
    require_auth(request)
    inst = instance_or_404(request.path_params["instanceId"])
    return ok(active_alerts(inst.id))


# ── Serveur ────────────────────────────────────────────────────

async def server_restart(request: Request):
    user = require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    # Une session admin volée ne doit pas pouvoir faire tourner le serveur en boucle.
    limiter.check(request, f"restart:{inst.id}", 3, 60)
    if not can_restart(inst):
        raise ApiError(501, "beammp-agent non configuré pour cette instance — voir BEAMMP_AGENT_URL/TOKEN/SERVICE dans .env")
    good, err = await restart_via_agent(inst)
    if not good:
        raise ApiError(502, err or "Redémarrage impossible")
    log_activity(inst.id, "server_restart", "Serveur redémarré")
    await notify_restart(inst, user["username"])
    return ok({"restarted": True})


async def server_update_check(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    return ok(await check_for_update(inst))


async def server_update(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    limiter.check(request, f"update:{inst.id}", 2, 300)
    before = await check_for_update(inst)
    if not before["enabled"]:
        raise ApiError(501, "Mise à jour non configurée pour cette instance — voir BEAMMP_AGENT_ASSET dans .env")
    good, result = await update_via_agent(inst)
    if not good:
        raise ApiError(502, result)
    log_activity(inst.id, "server_update", f"Serveur mis à jour vers {result}")
    await notify_update(inst, before.get("currentVersion"), str(result))
    return ok({"updated": True, "version": result})


routes = [
    Route("/api/i/{instanceId}/mods", list_mods),
    Route("/api/i/{instanceId}/mods/upload", upload_mod, methods=["POST"]),
    Route("/api/i/{instanceId}/mods/{id}/toggle", toggle_mod, methods=["POST"]),
    Route("/api/i/{instanceId}/mods/{id}", delete_mod, methods=["DELETE"]),
    Route("/api/i/{instanceId}/mods/{id}/official", toggle_official, methods=["PATCH"]),
    Route("/api/i/{instanceId}/mods/{id}/description", patch_description, methods=["PATCH"]),
    Route("/api/i/{instanceId}/mods/{id}/image", upload_image, methods=["POST"]),
    Route("/api/i/{instanceId}/maps/activate", maps_activate, methods=["POST"]),
    Route("/api/i/{instanceId}/config", get_config, methods=["GET"]),
    Route("/api/i/{instanceId}/config", patch_config, methods=["PATCH"]),
    Route("/api/i/{instanceId}/logs", get_logs),
    Route("/api/i/{instanceId}/alerts", get_alerts),
    Route("/api/i/{instanceId}/server/restart", server_restart, methods=["POST"]),
    Route("/api/i/{instanceId}/server/update-check", server_update_check),
    Route("/api/i/{instanceId}/server/update", server_update, methods=["POST"]),
]
