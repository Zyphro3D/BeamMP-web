"""Routes du mode appli : premier lancement, serveur local, mise à jour du panel."""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Awaitable, Callable

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.routing import Route

from . import appmode, supervisor, updater
from . import config as C
from .db import db, now_iso
from .files import read_text, write_text
from .modstate import format_toml_value, set_toml_key
from .security import ApiError, hash_password, require_admin, require_superadmin
from .web import instance_or_404, json_body, ok

# Fourni par app.py : recharge la configuration et relance le suivi du
# journal et la supervision après l'assistant.
reload_runtime: Callable[[], Awaitable[None]] | None = None

LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _host_name(value: str) -> str:
    """Nom d'hôte d'un en-tête Host ou d'une origine, sans port ni crochets IPv6."""
    value = value.strip().lower()
    if "://" in value:
        value = value.split("://", 1)[1]
    value = value.split("/", 1)[0]
    if value.startswith("["):
        return value[1:value.find("]")] if "]" in value else value
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def _require_local_request(request: Request) -> None:
    """La connexion vient de ce PC, et ni d'un autre site ouvert dans le
    navigateur (Origin), ni d'un nom DNS qui pointerait sur 127.0.0.1 (Host)."""
    peer = request.client.host if request.client else ""
    if peer not in LOCAL_HOSTS:
        raise ApiError(403, "La configuration initiale se fait depuis le PC où le panel est installé")
    if _host_name(request.headers.get("host", "")) not in LOCAL_HOSTS:
        raise ApiError(403, "Ouvrez le panel par http://127.0.0.1 ou http://localhost")
    origin = request.headers.get("origin")
    if origin is not None and _host_name(origin) not in LOCAL_HOSTS:
        raise ApiError(403, "Requête refusée : elle vient d'un autre site")


def _setup_needed() -> bool:
    if not appmode.enabled():
        return False
    no_admin = db().one("SELECT COUNT(*) AS n FROM users")["n"] == 0
    return no_admin or not appmode.configured()


def _default_server_dir() -> str:
    base = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    return str(Path(base) / "BeamMP-Server")


async def setup_status(request: Request):
    settings = appmode.load_settings() if appmode.enabled() else {}
    server_dir = settings.get("server_dir") or _default_server_dir()
    exe = Path(appmode.server_paths(server_dir)["BEAMMP_SERVER_EXE"])
    return ok({
        "appMode": appmode.enabled(),
        "needed": _setup_needed(),
        "hasAdmin": db().one("SELECT COUNT(*) AS n FROM users")["n"] > 0,
        # Le chemin (profil Windows) ne sert qu'à l'assistant.
        "serverDir": server_dir if _setup_needed() else None,
        "serverInstalled": exe.is_file(),
    })


async def setup(request: Request):
    if not _setup_needed():
        raise ApiError(409, "Le panel est déjà configuré")
    # Tant qu'aucun compte n'existe, n'importe qui pourrait se déclarer
    # administrateur : l'assistant n'est accepté que depuis ce PC. Si un
    # compte existe déjà (dossier du serveur seulement à refaire), il faut en
    # plus être connecté en SuperAdmin.
    _require_local_request(request)
    if db().one("SELECT COUNT(*) AS n FROM users")["n"] > 0:
        require_superadmin(request)
    body = await json_body(request)
    server_dir = str(body.get("serverDir") or "").strip().strip('"')
    if not server_dir or not os.path.isabs(server_dir):
        raise ApiError(400, "Indiquez le chemin complet du dossier du serveur BeamMP")
    # Le panel lancera l'exécutable de ce dossier : pas de partage réseau.
    if server_dir.startswith(("\\\\", "//")):
        raise ApiError(400, "Le dossier du serveur doit être sur un disque de ce PC, pas un partage réseau")
    exe = Path(appmode.server_paths(server_dir)["BEAMMP_SERVER_EXE"])
    if not exe.is_file():
        if not body.get("downloadServer"):
            raise ApiError(400, f"BeamMP-Server introuvable dans {server_dir}")
        try:
            await supervisor.download_latest(server_dir)
        except Exception as err:
            raise ApiError(502, f"Téléchargement de BeamMP-Server impossible : {err}")

    has_admin = db().one("SELECT COUNT(*) AS n FROM users")["n"] > 0
    if not has_admin:
        username = str(body.get("username") or "").strip()
        password = str(body.get("password") or "")
        if not (1 <= len(username) <= 100) or len(password) < 8:
            raise ApiError(400, "Identifiant requis et mot de passe de 8 caractères minimum")

    # ServerConfig.toml : BeamMP le complète lui-même au premier démarrage ;
    # on y met seulement le nom et la clé d'authentification s'ils sont donnés.
    cfg_path = appmode.server_paths(server_dir)["BEAMMP_CONFIG_PATH"]
    content = read_text(cfg_path) or "[General]\n"
    # BeamMP-Server refuse de démarrer sans clé (il se ferme au bout de 10 s).
    has_key = bool(re.search(r'^AuthKey\s*=\s*"[^"]+"', content, re.M))
    if not has_key and not str(body.get("authKey") or "").strip():
        raise ApiError(400, "La clé d'authentification BeamMP est obligatoire : sans elle, le serveur ne démarre pas")
    for key, value in (("Name", body.get("serverName")), ("AuthKey", body.get("authKey"))):
        value = re.sub(r"[\r\n  ]", "", str(value or "")).strip()
        if value:
            content = set_toml_key(content, key, format_toml_value("Name", value))
    write_text(cfg_path, content)

    if not has_admin:
        pw_hash = await run_in_threadpool(hash_password, password)
        db().run("INSERT INTO users (username, password, role, created_at) VALUES (?, ?, 'superadmin', ?)",
                 [username, pw_hash, now_iso()])
    appmode.save_settings(server_dir=server_dir, server_name=str(body.get("serverName") or "").strip() or None)
    if reload_runtime:
        await reload_runtime()
    return ok({"configured": True})


# ── Serveur local (supervision) ─────────────────────────────────

def _local(request: Request) -> supervisor.ServerProcess:
    inst = instance_or_404(request.path_params["instanceId"])
    sp = supervisor.get(inst)
    if not sp:
        raise ApiError(501, "Le serveur de cette instance n'est pas géré par le panel")
    return sp


async def server_state(request: Request):
    require_admin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    sp = supervisor.get(inst)
    return ok({"managed": bool(sp), **(sp.state() if sp else {})})


async def server_start(request: Request):
    require_admin(request)
    sp = _local(request)
    try:
        await sp.start()
    except OSError as err:
        raise ApiError(500, str(err))
    return ok({"managed": True, **sp.state()})


async def server_stop(request: Request):
    require_admin(request)
    sp = _local(request)
    await sp.stop()
    return ok({"managed": True, **sp.state()})


# ── Mise à jour du panel ───────────────────────────────────────

async def panel_update_state(request: Request):
    require_admin(request)
    return ok(updater.public_state() | {"enabled": updater.enabled()})


async def panel_update_check(request: Request):
    require_admin(request)
    return ok(await updater.check())


async def panel_update_install(request: Request):
    require_superadmin(request)
    try:
        state = await updater.install()
    except ValueError as err:
        raise ApiError(400, str(err))
    except Exception as err:
        raise ApiError(502, f"Mise à jour impossible : {err}")

    async def restart_soon() -> None:
        await asyncio.sleep(1.5)  # laisser partir la réponse
        await supervisor.stop_all()
        updater.restart_app()
    asyncio.get_running_loop().create_task(restart_soon())
    return ok(state | {"restarting": True})


routes = [
    Route("/api/setup", setup_status, methods=["GET"]),
    Route("/api/setup", setup, methods=["POST"]),
    Route("/api/i/{instanceId}/server/state", server_state),
    Route("/api/i/{instanceId}/server/start", server_start, methods=["POST"]),
    Route("/api/i/{instanceId}/server/stop", server_stop, methods=["POST"]),
    Route("/api/panel/update", panel_update_state, methods=["GET"]),
    Route("/api/panel/update/check", panel_update_check, methods=["POST"]),
    Route("/api/panel/update/install", panel_update_install, methods=["POST"]),
]
