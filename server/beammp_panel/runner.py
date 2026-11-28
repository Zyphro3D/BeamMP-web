"""Conteneur « jeu » (Linux) : fait tourner les BeamMP-Server du panel.

Lancé par `python -m beammp_panel.runner` dans un conteneur à part (réseau de l'hôte, uid 1000,
sans docker.sock ni sudo). Il réutilise le superviseur de l'appli Windows : un processus par
serveur, relance bornée en cas de plantage, un seul exécutable BeamMP-Server pour tous.

Le panel le pilote en HTTP (jeton partagé, BEAMMP_RUNNER_TOKEN) et ne lui envoie que des
identifiants de serveur, jamais de chemin :
  default  → BEAMMP_MAIN_DIR (le serveur de l'installation)
  <id>     → BEAMMP_SERVERS_PATH/<id> (serveurs ajoutés par le bouton du panel)

Les serveurs voulus en marche sont notés dans BEAMMP_SERVERS_PATH/_runner.json : un redémarrage
du conteneur (ou de la machine) les relance, et un redémarrage du panel ne les coupe pas.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
import os
from pathlib import Path
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import supervisor
from .config import InstanceConfig
from .servers import ID_RE

log = logging.getLogger("beammp_panel.runner")

DEFAULT_ID = "default"
STATE_FILE = "_runner.json"


class Settings:
    def __init__(self) -> None:
        self.token = os.environ.get("BEAMMP_RUNNER_TOKEN", "")
        self.bind = os.environ.get("BEAMMP_RUNNER_BIND", "127.0.0.1")
        self.port = int(os.environ.get("BEAMMP_RUNNER_PORT", "3010"))
        self.main_dir = Path(os.environ.get("BEAMMP_MAIN_DIR", "/beammp/main"))
        self.servers_dir = Path(os.environ.get("BEAMMP_SERVERS_PATH", "/beammp/servers"))
        self.exe = Path(os.environ.get("BEAMMP_SERVER_EXE", str(self.main_dir / "BeamMP-Server")))


class Error(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _json(data: dict[str, Any], status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status)


def create_app(settings: Settings | None = None) -> Starlette:
    s = settings or Settings()
    if len(s.token) < 32:
        raise SystemExit("BEAMMP_RUNNER_TOKEN absent ou trop court (32 caractères au moins)")
    state_path = s.servers_dir / STATE_FILE
    lock = asyncio.Lock()

    # ── serveurs connus ───────────────────────────────────────

    def workdir(sid: str) -> Path:
        if sid == DEFAULT_ID:
            return s.main_dir
        if not ID_RE.match(sid):
            raise Error(400, "Identifiant de serveur invalide")
        return s.servers_dir / sid

    def proc(sid: str) -> supervisor.ServerProcess:
        d = workdir(sid)
        if not (d / "ServerConfig.toml").is_file():
            raise Error(404, f"Serveur {sid} inconnu : pas de ServerConfig.toml dans son dossier")
        sp = supervisor._servers.get(sid)
        if sp is None:
            inst = InstanceConfig(id=sid, name=sid, server_ip="", server_port="", beammp=None,  # type: ignore[arg-type]
                                  agent=None, server_exe=str(s.exe), workdir=str(d))
            sp = supervisor._servers[sid] = supervisor.ServerProcess(inst, notify=False)
        return sp

    def wanted() -> list[str]:
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        ids = data.get("wanted", []) if isinstance(data, dict) else []
        return [i for i in ids if isinstance(i, str) and (i == DEFAULT_ID or ID_RE.match(i))]

    def set_wanted(sid: str, on: bool) -> None:
        ids = [i for i in wanted() if i != sid] + ([sid] if on else [])
        tmp = state_path.with_name(STATE_FILE + ".tmp")
        tmp.write_text(json.dumps({"wanted": ids}), encoding="utf-8")
        os.replace(tmp, state_path)

    # ── routes ────────────────────────────────────────────────

    def authorized(request: Request) -> bool:
        got = request.headers.get("authorization", "")
        return hmac.compare_digest(got.encode(), f"Bearer {s.token}".encode())

    def guarded(handler):
        async def wrapper(request: Request):
            if not authorized(request):
                return _json({"error": "Jeton refusé"}, 401)
            try:
                return await handler(request)
            except Error as err:
                return _json({"error": str(err)}, err.status)
            except (OSError, ValueError, RuntimeError) as err:
                return _json({"error": str(err)}, 500)
        return wrapper

    async def health(_: Request):
        return _json({"ok": True})

    async def list_servers(_: Request):
        return _json({"servers": {sid: sp.state() for sid, sp in supervisor._servers.items()},
                      "wanted": wanted()})

    async def state(request: Request):
        return _json(proc(request.path_params["sid"]).state())

    async def start(request: Request):
        sid = request.path_params["sid"]
        sp = proc(sid)
        async with lock:
            set_wanted(sid, True)
        await sp.start()
        return _json(sp.state())

    async def stop(request: Request):
        sid = request.path_params["sid"]
        sp = proc(sid)
        async with lock:
            set_wanted(sid, False)
        await sp.stop()
        return _json(sp.state())

    async def restart(request: Request):
        sid = request.path_params["sid"]
        sp = proc(sid)
        async with lock:
            set_wanted(sid, True)
        await sp.restart()
        return _json(sp.state())

    async def forget(request: Request):
        """Serveur retiré du panel : arrêté, oublié ; son dossier peut ensuite être archivé."""
        sid = request.path_params["sid"]
        if sid == DEFAULT_ID:
            raise Error(400, "Le serveur de l'installation ne se retire pas")
        workdir(sid)                       # identifiant validé
        async with lock:
            set_wanted(sid, False)
        sp = supervisor._servers.pop(sid, None)
        if sp:
            sp.wanted = False
            await sp.shutdown()
        return _json({"ok": True})

    async def version(_: Request):
        sp = supervisor._servers.get(DEFAULT_ID) or next(iter(supervisor._servers.values()), None)
        if sp is None:
            sp = proc(DEFAULT_ID)
        return _json({"version": await sp.version()})

    async def update(request: Request):
        try:
            body = await request.json()
        except ValueError:
            raise Error(400, "Corps JSON attendu")
        url, sha = str(body.get("download_url", "")), str(body.get("sha256", ""))
        if len(sha) != 64:
            raise Error(400, "Empreinte sha256 attendue")
        sp = supervisor._servers.get(DEFAULT_ID) or next(iter(supervisor._servers.values()), None) or proc(DEFAULT_ID)
        await sp.install(url, sha)        # tous les serveurs du même exécutable sont relancés
        return _json({"ok": True, "version": await sp.version()})

    # ── cycle de vie ──────────────────────────────────────────

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        s.servers_dir.mkdir(parents=True, exist_ok=True)
        for sid in wanted():
            try:
                await proc(sid).start()
            except (Error, OSError) as err:
                log.error("Démarrage de %s impossible : %s", sid, err)
        log.info("Conteneur « jeu » prêt : %s serveur(s) en marche, exécutable %s",
                 sum(1 for sp in supervisor._servers.values() if sp.running()), s.exe)
        try:
            yield
        finally:
            await supervisor.stop_all()   # arrêt du conteneur : serveurs arrêtés proprement, « voulus » gardés

    routes = [
        Route("/health", health),
        Route("/servers", guarded(list_servers)),
        Route("/servers/{sid}/state", guarded(state)),
        Route("/servers/{sid}/start", guarded(start), methods=["POST"]),
        Route("/servers/{sid}/stop", guarded(stop), methods=["POST"]),
        Route("/servers/{sid}/restart", guarded(restart), methods=["POST"]),
        Route("/servers/{sid}/forget", guarded(forget), methods=["POST"]),
        Route("/version", guarded(version)),
        Route("/update", guarded(update), methods=["POST"]),
    ]
    return Starlette(routes=routes, lifespan=lifespan)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    s = Settings()
    uvicorn.run(create_app(s), host=s.bind, port=s.port, log_level="warning")


if __name__ == "__main__":
    main()
