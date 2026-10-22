"""Routes d'administration : comptes, joueurs, cohérence, scan-import, analyse."""

from __future__ import annotations

import os

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.routing import Route

from . import config as C
from .analyzer import analyze_metadata, analyze_zip
from .db import db, dumps, now_iso
from .files import (delete_file, ensure_dir, list_files, move_file, resolve_within, safe_basename)
from .security import ApiError, hash_password, require_admin, require_auth, require_superadmin
from .web import instance_or_404, int_param, json_body, ok

INACTIVE_DIRS = {"map": "inactive_map", "mod": "inactive_mod", "vehicle": "inactive_mod"}
ANALYZE_EXISTING_BATCH = 300


# ── Demandes de compte ─────────────────────────────────────────

async def list_requests(request: Request):
    require_superadmin(request)
    # Une ligne par demande : la v2 joignait known_players sur le pseudo
    # seul et dupliquait la demande pour chaque instance où le joueur était
    # connu. On agrège donc les compteurs toutes instances confondues.
    return ok(db().all(
        """SELECT ar.*, kp.connection_count, kp.first_seen, kp.last_seen
           FROM account_requests ar
           LEFT JOIN (SELECT beammp_username, SUM(connection_count) AS connection_count,
                             MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen
                      FROM known_players GROUP BY beammp_username) kp
             ON kp.beammp_username = ar.beammp_username
           ORDER BY ar.requested_at DESC"""))


async def review_request(request: Request):
    reviewer = require_superadmin(request)
    req_id = int_param(request, "id")
    body = await json_body(request)
    action = body.get("action")
    password = body.get("password")
    row = db().one("SELECT * FROM account_requests WHERE id = ?", [req_id])
    if not row:
        raise ApiError(404, "Not found")
    if row["status"] != "pending":
        raise ApiError(409, "Already processed")

    if action == "approve":
        if not isinstance(password, str) or len(password) < 8:
            raise ApiError(400, "Password required (min 8 chars)")
        pw_hash = await run_in_threadpool(hash_password, password)
        # Moindre privilège : un compte demandé par un joueur démarre en
        # moderator (lecture seule) ; la promotion est un choix du SuperAdmin.
        cur = db().run("INSERT OR IGNORE INTO users (username, password, role, created_at) VALUES (?, ?, 'moderator', ?)",
                       [row["beammp_username"], pw_hash, now_iso()])
        if cur.rowcount == 0:
            raise ApiError(409, f'Le nom d\'utilisateur "{row["beammp_username"]}" est déjà pris')
        db().run("UPDATE account_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?",
                 [reviewer["id"], now_iso(), req_id])
        return ok({"approved": row["beammp_username"]})
    if action == "reject":
        db().run("UPDATE account_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?",
                 [reviewer["id"], now_iso(), req_id])
        return ok({"rejected": row["beammp_username"]})
    raise ApiError(400, "action must be approve or reject")


# ── Joueurs et utilisateurs ────────────────────────────────────

async def list_players(request: Request):
    require_auth(request)
    instance_id = request.query_params.get("instanceId") or C.config.instances[0].id
    # Classement par temps de jeu, pas par date : un ancien joueur fidèle ne
    # disparaît pas de la liste parce qu'il ne s'est pas connecté récemment.
    return ok(db().all("SELECT * FROM known_players WHERE instance_id = ? ORDER BY total_seconds DESC LIMIT 200",
                       [instance_id]))


async def list_users(request: Request):
    require_superadmin(request)
    return ok(db().all("SELECT id, username, role, created_at FROM users ORDER BY created_at"))


async def set_role(request: Request):
    require_superadmin(request)
    user_id = int_param(request, "id")
    role = (await json_body(request)).get("role")
    if role not in ("superadmin", "admin", "moderator"):
        raise ApiError(400, "Invalid role")
    cur = db().run("UPDATE users SET role = ? WHERE id = ?", [role, user_id])
    if cur.rowcount == 0:
        raise ApiError(404, "Not found")
    return ok(db().one("SELECT id, username, role FROM users WHERE id = ?", [user_id]))


async def reset_password(request: Request):
    require_superadmin(request)
    user_id = int_param(request, "id")
    password = (await json_body(request)).get("password")
    if not isinstance(password, str) or len(password) < 8:
        raise ApiError(400, "Password required (min 8 chars)")
    pw_hash = await run_in_threadpool(hash_password, password)
    cur = db().run("UPDATE users SET password = ? WHERE id = ?", [pw_hash, user_id])
    if cur.rowcount == 0:
        raise ApiError(404, "Not found")
    return ok(db().one("SELECT id, username, role FROM users WHERE id = ?", [user_id]))


async def delete_user(request: Request):
    me = require_superadmin(request)
    user_id = int_param(request, "id")
    if me["id"] == user_id:
        raise ApiError(400, "Cannot delete yourself")
    db().run("DELETE FROM users WHERE id = ?", [user_id])
    return ok({"deleted": True})


# ── Cohérence base ↔ fichiers ──────────────────────────────────

def _scan_consistency(inst) -> dict:
    rp = inst.beammp.resources_path
    images_dir = C.config.images_path
    mods = db().all("SELECT * FROM mods WHERE instance_id = ?", [inst.id])
    client = set(list_files(os.path.join(rp, "Client")))
    inactive_mod = set(list_files(os.path.join(rp, "inactive_mod")))
    inactive_map = set(list_files(os.path.join(rp, "inactive_map")))
    images = list_files(images_dir)

    referenced_files: set[str] = set()
    # Le dossier d'images est partagé par toutes les instances : une image
    # utilisée par une autre instance n'est pas orpheline (la v2 la
    # signalait et son correctif la supprimait).
    referenced_images = {r["image"] for r in db().all("SELECT image FROM mods WHERE image IS NOT NULL")}
    issues: list[dict] = []
    active_maps: list[dict] = []

    for mod in mods:
        referenced_files.add(mod["filename"])
        if mod["is_official"]:
            if mod["type"] == "map" and mod["active"]:
                active_maps.append(mod)
            continue
        in_client = mod["filename"] in client
        in_inactive = mod["filename"] in (inactive_map if mod["type"] == "map" else inactive_mod)
        inactive_name = INACTIVE_DIRS[mod["type"]]
        if mod["type"] == "map" and mod["active"]:
            active_maps.append(mod)

        meta = {"modId": mod["id"], "filename": mod["filename"], "inactiveDirName": inactive_name}
        if mod["active"] and in_inactive and not in_client:
            issues.append({"id": f"wrong_loc_active_{mod['id']}", "type": "wrong_location", "severity": "error",
                           "description": f'"{mod["name"]}" est actif en BDD mais le fichier est dans {inactive_name}/',
                           "fix": "move_to_client", "meta": meta})
        elif not mod["active"] and in_client and not in_inactive:
            issues.append({"id": f"wrong_loc_inactive_{mod['id']}", "type": "wrong_location", "severity": "error",
                           "description": f'"{mod["name"]}" est inactif en BDD mais le fichier est dans Client/',
                           "fix": "move_to_inactive", "meta": meta})
        elif not in_client and not in_inactive:
            issues.append({"id": f"missing_file_{mod['id']}", "type": "missing_file", "severity": "error",
                           "description": f'"{mod["name"]}" ({mod["filename"]}) introuvable ni dans Client/ ni dans {inactive_name}/',
                           "fix": "delete_db_record",
                           "meta": {"modId": mod["id"], "filename": mod["filename"], "type": mod["type"]}})
        if mod["image"] and mod["image"] not in images:
            issues.append({"id": f"missing_image_{mod['id']}", "type": "missing_image", "severity": "warning",
                           "description": f'Image de "{mod["name"]}" référencée en BDD ({mod["image"]}) mais fichier absent',
                           "fix": "clear_image_ref", "meta": {"modId": mod["id"], "image": mod["image"]}})

    if len(active_maps) > 1:
        names = ", ".join(m["name"] for m in active_maps)
        issues.append({"id": "multiple_active_maps", "type": "multiple_active_maps", "severity": "error",
                       "description": f"{len(active_maps)} cartes marquées actives simultanément ({names}) — une seule devrait l'être",
                       "fix": "fix_multiple_active_maps",
                       "meta": {"keepId": active_maps[0]["id"], "ids": ",".join(str(m["id"]) for m in active_maps)}})

    for location, label, files in (("client", "Client", client), ("inactive_mod", "inactive_mod", inactive_mod),
                                   ("inactive_map", "inactive_map", inactive_map)):
        for filename in sorted(files):
            if filename not in referenced_files:
                issues.append({"id": f"orphan_{'client' if location == 'client' else location}_{filename}",
                               "type": "orphan_file", "severity": "warning",
                               "description": f"Fichier orphelin dans {label}/ : {filename} (non référencé en BDD)",
                               "fix": "delete_orphan_file", "meta": {"filename": filename, "location": location}})
    for img in sorted(images):
        if img not in referenced_images:
            issues.append({"id": f"orphan_image_{img}", "type": "orphan_image", "severity": "warning",
                           "description": f"Image orpheline : {img} (non référencée en BDD)",
                           "fix": "delete_orphan_image", "meta": {"image": img}})

    return {
        "instanceId": inst.id,
        "scannedAt": now_iso(),
        "summary": {"total": len(issues),
                    "errors": sum(1 for i in issues if i["severity"] == "error"),
                    "warnings": sum(1 for i in issues if i["severity"] == "warning")},
        "issues": issues,
    }


async def consistency(request: Request):
    require_auth(request)
    inst = instance_or_404(request.path_params["instanceId"])
    return ok(await run_in_threadpool(_scan_consistency, inst))


def _mod_for_fix(inst, meta: dict) -> dict:
    mod_id = meta.get("modId")
    mod = db().one("SELECT * FROM mods WHERE id = ? AND instance_id = ?", [mod_id, inst.id]) \
        if isinstance(mod_id, int) else None
    if not mod:
        raise ApiError(404, "Mod not found")
    return mod


async def consistency_fix(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    body = await json_body(request)
    fix = body.get("fix")
    meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
    rp = inst.beammp.resources_path
    client_dir = os.path.join(rp, "Client")
    # `meta` vient du client : les chemins sont toujours recalculés côté
    # serveur depuis l'id du mod, ou réduits à un nom de base vérifié.

    if fix == "move_to_client":
        mod = _mod_for_fix(inst, meta)
        move_file(os.path.join(rp, INACTIVE_DIRS[mod["type"]], mod["filename"]), os.path.join(client_dir, mod["filename"]))
        db().run("UPDATE mods SET active = 1 WHERE id = ?", [mod["id"]])
        return ok({"fixed": True, "action": fix, "filename": mod["filename"]})
    if fix == "move_to_inactive":
        mod = _mod_for_fix(inst, meta)
        dest_dir = os.path.join(rp, INACTIVE_DIRS[mod["type"]])
        ensure_dir(dest_dir)
        move_file(os.path.join(client_dir, mod["filename"]), os.path.join(dest_dir, mod["filename"]))
        db().run("UPDATE mods SET active = 0 WHERE id = ?", [mod["id"]])
        return ok({"fixed": True, "action": fix, "filename": mod["filename"]})
    if fix == "delete_db_record":
        mod_id = meta.get("modId")
        db().run("DELETE FROM mods WHERE id = ? AND instance_id = ?", [mod_id, inst.id])
        return ok({"fixed": True, "action": fix, "modId": mod_id})
    if fix == "clear_image_ref":
        mod_id = meta.get("modId")
        db().run("UPDATE mods SET image = NULL WHERE id = ? AND instance_id = ?", [mod_id, inst.id])
        return ok({"fixed": True, "action": fix, "modId": mod_id})
    if fix == "fix_multiple_active_maps":
        keep = meta.get("keepId")
        ids = [int(x) for x in str(meta.get("ids", "")).split(",") if x.strip().isdigit()]
        deactivated = [i for i in ids if i != keep]
        for i in deactivated:
            db().run("UPDATE mods SET active = 0 WHERE id = ? AND instance_id = ?", [i, inst.id])
        return ok({"fixed": True, "action": fix, "deactivated": deactivated})
    if fix == "delete_orphan_file":
        sub = {"client": "Client", "inactive_mod": "inactive_mod", "inactive_map": "inactive_map"}.get(meta.get("location"))
        if not sub:
            raise ApiError(400, f"Unknown location: {meta.get('location')}")
        name = safe_basename(meta.get("filename"))
        if not name:
            raise ApiError(400, "Invalid filename")
        path = resolve_within(os.path.join(rp, sub), name)
        if not path:
            raise ApiError(400, "Invalid path")
        delete_file(path)
        return ok({"fixed": True, "action": fix, "filename": name})
    if fix == "delete_orphan_image":
        name = safe_basename(meta.get("image"))
        if not name:
            raise ApiError(400, "Invalid filename")
        if db().one("SELECT id FROM mods WHERE image = ?", [name]):
            raise ApiError(409, "Image encore utilisée par un mod")
        path = resolve_within(C.config.images_path, name)
        if not path:
            raise ApiError(400, "Invalid path")
        delete_file(path)
        return ok({"fixed": True, "action": fix, "image": name})
    raise ApiError(400, f"Unknown fix action: {fix}")


# ── Scan & Import ──────────────────────────────────────────────

def _scan_import(inst) -> dict:
    rp = inst.beammp.resources_path
    existing = {r["filename"] for r in db().all("SELECT filename FROM mods WHERE instance_id = ?", [inst.id])}
    results: list[dict] = []
    for sub, active, key in (("Client", True, "client"), ("inactive_mod", False, "inactive_mod"),
                             ("inactive_map", False, "inactive_map")):
        directory = os.path.join(rp, sub)
        if not os.path.isdir(directory):
            continue
        for filename in sorted(f for f in os.listdir(directory) if f.lower().endswith(".zip")):
            if filename in existing:
                results.append({"filename": filename, "hasImage": False, "status": "skipped"})
                continue
            try:
                base = filename[:-4]
                a = analyze_zip(os.path.join(directory, filename), key, C.config.images_path, base, inst.id)
                db().run(
                    "INSERT OR IGNORE INTO mods (instance_id, name, type, filename, image, active, metadata, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [inst.id, a["name"], a["type"], filename, a["imageFilename"], int(active), dumps(a["metadata"]), now_iso()])
                existing.add(filename)
                results.append({"filename": filename, "name": a["name"], "type": a["type"], "active": active,
                                "hasImage": bool(a["imageFilename"]), "status": "imported"})
            except Exception as err:
                results.append({"filename": filename, "hasImage": False, "status": "error", "error": str(err)})
    return {
        "imported": sum(1 for r in results if r["status"] == "imported"),
        "skipped": sum(1 for r in results if r["status"] == "skipped"),
        "errors": sum(1 for r in results if r["status"] == "error"),
        "total": len(results),
        "results": results,
    }


async def scan_import(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    return ok(await run_in_threadpool(_scan_import, inst))


def _analyze_existing(inst) -> dict:
    rows = db().all("SELECT id, type, filename, active FROM mods WHERE instance_id = ? AND metadata IS NULL "
                    "ORDER BY id LIMIT ?", [inst.id, ANALYZE_EXISTING_BATCH + 1])
    remaining = len(rows) > ANALYZE_EXISTING_BATCH
    rows = rows[:ANALYZE_EXISTING_BATCH]
    analyzed = not_found = errors = 0
    for mod in rows:
        sub = "Client" if mod["active"] else INACTIVE_DIRS[mod["type"]]
        path = os.path.join(inst.beammp.resources_path, sub, mod["filename"])
        if not os.path.exists(path):
            not_found += 1
            continue
        try:
            metadata = analyze_metadata(path, mod["type"])
        except Exception:
            errors += 1
            continue
        # « other/unknown » plutôt que NULL : sinon le même mod reviendrait à
        # chaque passage alors qu'il n'a légitimement rien à extraire.
        stored = metadata or {"kind": "other", "other": {"subtype": "unknown"}}
        db().run("UPDATE mods SET metadata = ? WHERE id = ?", [dumps(stored), mod["id"]])
        analyzed += 1
    return {"analyzed": analyzed, "notFound": not_found, "errors": errors, "total": len(rows), "remaining": remaining}


async def analyze_existing(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    return ok(await run_in_threadpool(_analyze_existing, inst))


routes = [
    Route("/api/admin/requests", list_requests),
    Route("/api/admin/requests/{id}", review_request, methods=["POST"]),
    Route("/api/admin/players", list_players),
    Route("/api/admin/users", list_users),
    Route("/api/admin/users/{id}/role", set_role, methods=["PATCH"]),
    Route("/api/admin/users/{id}/password", reset_password, methods=["PATCH"]),
    Route("/api/admin/users/{id}", delete_user, methods=["DELETE"]),
    Route("/api/admin/i/{instanceId}/consistency", consistency),
    Route("/api/admin/i/{instanceId}/consistency/fix", consistency_fix, methods=["POST"]),
    Route("/api/admin/i/{instanceId}/scan-import", scan_import, methods=["POST"]),
    Route("/api/admin/i/{instanceId}/mods/analyze-existing", analyze_existing, methods=["POST"]),
]
