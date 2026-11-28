"""Application Starlette : middlewares, routes, interface, démarrage."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import secrets
from pathlib import Path

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import (VERSION, appmode, library, logwatch, modstate, routes_admin, routes_app, routes_auth, routes_dashboard, routes_discord,
               routes_earth, routes_presets, routes_public, routes_servers, supervisor, updater)
from . import config as C
from .db import db, init_db, now_iso
from .security import ApiError, hash_password

log = logging.getLogger("beammp_panel")

# Mêmes en-têtes que @fastify/helmet dans la v2. Pas de 'unsafe-inline'
# pour les scripts : le build Vite n'émet qu'un <script src> externe.
CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "script-src-attr 'none'",
])
SECURITY_HEADERS = [
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
    (b"origin-agent-cluster", b"?1"),
    (b"referrer-policy", b"no-referrer"),
    (b"strict-transport-security", b"max-age=15552000; includeSubDomains"),
    (b"x-content-type-options", b"nosniff"),
    (b"x-dns-prefetch-control", b"off"),
    (b"x-download-options", b"noopen"),
    (b"x-frame-options", b"SAMEORIGIN"),
    (b"x-permitted-cross-domain-policies", b"none"),
    (b"x-xss-protection", b"0"),
    (b"x-beammp-panel-version", VERSION.encode()),
]


def csp_header() -> bytes:
    """CSP avec un jeton aléatoire neuf à chaque réponse. Aucun script du panel ne le porte : il sert au script de
    détection des robots que Cloudflare injecte derrière son proxy (il recopie le jeton lu dans l'en-tête), qui était
    bloqué en console. Sans Cloudflare devant, il ne change rien."""
    return CSP.replace("script-src 'self'", f"script-src 'self' 'nonce-{secrets.token_urlsafe(16)}'", 1).encode()


# Durées de cache des fichiers servis : les fichiers du build ont une empreinte dans leur nom (jamais réécrits),
# les aperçus peuvent être remplacés sous le même nom, la page d'entrée doit toujours être relue.
CACHE_IMMUABLE = b"public, max-age=31536000, immutable"
CACHE_IMAGES = b"public, max-age=604800"
CACHE_PAGE = b"no-cache"


def cache_header(path: str, content_type: bytes) -> bytes | None:
    if path.startswith("/api/") or path == "/api":
        return None
    if path.startswith("/assets/") and not content_type.startswith(b"text/html"):   # fichier absent : la page d'entrée revient
        return CACHE_IMMUABLE
    if path.startswith("/images/"):
        return CACHE_IMAGES
    if content_type.startswith(b"text/html"):
        return CACHE_PAGE
    return None


class HeadersMiddleware:
    """Ajoute les en-têtes de sécurité et de cache à chaque réponse (ASGI pur : compatible SSE)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                existing = {k.lower() for k, _ in headers}
                ajout = [h for h in SECURITY_HEADERS if h[0] not in existing]
                if b"content-security-policy" not in existing:
                    ajout.append((b"content-security-policy", csp_header()))
                if b"cache-control" not in existing and message.get("status", 200) == 200:
                    ctype = next((v for k, v in headers if k.lower() == b"content-type"), b"")
                    cache = cache_header(scope.get("path", ""), ctype)
                    if cache:
                        ajout.append((b"cache-control", cache))
                message["headers"] = headers + ajout
            await send(message)

        await self.app(scope, receive, send_with_headers)


THUMB_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:webp|png|jpe?g)", re.I)
THUMB_WIDTH = 400


def make_thumb(src: Path, out: Path) -> None:
    """Réduit `src` à THUMB_WIDTH px de large au plus (WebP qualité 78), écriture atomique."""
    from PIL import Image, ImageOps
    with Image.open(src) as img:
        img = ImageOps.exif_transpose(img)
        if img.width > THUMB_WIDTH:
            img = img.resize((THUMB_WIDTH, round(img.height * THUMB_WIDTH / img.width)), Image.Resampling.LANCZOS)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".tmp")
        img.save(tmp, "WEBP", quality=78)
    os.replace(tmp, out)


def default_frontend_dir() -> str:
    candidates = [
        os.environ.get("FRONTEND_DIR", ""),
        str(Path(__file__).resolve().parent / "static"),
        str(Path(__file__).resolve().parents[2] / "frontend" / "dist"),
    ]
    return next((c for c in candidates if c and Path(c, "index.html").is_file()), "")


async def api_error(request: Request, exc: ApiError):
    return JSONResponse({"error": exc.message}, status_code=exc.status)


async def http_error(request: Request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


async def server_error(request: Request, exc: Exception):
    log.exception("Erreur non gérée sur %s %s", request.method, request.url.path)
    return JSONResponse({"error": "Internal Server Error"}, status_code=500)


# Valeurs d'exemple publiques (.env.example, anciennes docs) : quiconque a lu
# le dépôt pourrait signer des jetons ou se connecter avec.
PLACEHOLDER_MARKS = ("change-me", "changeme", "change_me")
DEFAULT_PASSWORDS = {"changeme123", "changeme", "password", "motdepasse", "admin123"}


def _is_placeholder(value: str) -> bool:
    low = value.lower()
    return any(mark in low for mark in PLACEHOLDER_MARKS)


def check_startup() -> None:
    secret = C.config.jwt_secret
    if not secret or _is_placeholder(secret):
        raise SystemExit("[FATAL] JWT_SECRET doit être une valeur aléatoire forte (openssl rand -hex 32), "
                         "pas la valeur d'exemple de .env.example")
    if len(secret) < 32:
        raise SystemExit("[FATAL] JWT_SECRET trop court — 32 caractères minimum")
    if not C.config.allowed_origin:
        log.info("ALLOWED_ORIGIN non défini — mode même origine.")


def create_initial_superadmin() -> None:
    username = os.environ.get("SUPERADMIN_USERNAME")
    password = os.environ.get("SUPERADMIN_PASSWORD")
    if not username or not password:
        return
    if db().one("SELECT COUNT(*) AS n FROM users")["n"] > 0:
        return
    if len(password) < 8:
        log.warning("SUPERADMIN_PASSWORD trop court (8 caractères minimum) — ignoré")
        return
    if password.lower() in DEFAULT_PASSWORDS or _is_placeholder(password):
        log.warning("SUPERADMIN_PASSWORD est une valeur d'exemple connue — compte non créé, choisissez un vrai mot de passe")
        return
    db().run("INSERT INTO users (username, password, role, created_at) VALUES (?, ?, 'superadmin', ?)",
             [username, hash_password(password), now_iso()])
    log.info('SuperAdmin "%s" créé', username)


def local_url() -> str:
    host = C.config.host if C.config.host not in ("0.0.0.0", "::") else "127.0.0.1"
    return f"http://{host}:{C.config.port}/"


def _open_browser() -> None:
    import webbrowser
    target = local_url() + ("setup" if appmode.enabled() and not appmode.configured() else "")
    webbrowser.open(target)


def create_app(*, start_watchers: bool = True, frontend_dir: str | None = None) -> Starlette:
    frontend = frontend_dir if frontend_dir is not None else default_frontend_dir()
    images = C.config.images_path
    Path(images).mkdir(parents=True, exist_ok=True)

    async def thumb(request: Request):
        """Aperçu réduit à 400 px de large pour les grilles (cartes de mods, catalogue) : les anciens aperçus font jusqu'à
        640 px et 70 Ko pour une vignette de 112 px de haut. Fabriqué une fois, gardé dans images/.thumbs, refait si
        l'original change. Un nom hors du dossier ou illisible renvoie 404."""
        name = request.path_params["name"]
        if not THUMB_NAME.fullmatch(name):
            return JSONResponse({"error": "Not found"}, status_code=404)
        src = Path(images, name)
        if not src.is_file():
            return JSONResponse({"error": "Not found"}, status_code=404)
        out = Path(images, ".thumbs", Path(name).stem + ".webp")
        try:
            if not out.is_file() or out.stat().st_mtime < src.stat().st_mtime:
                await asyncio.to_thread(make_thumb, src, out)
        except Exception:      # image illisible : l'original reste servi tel quel
            log.warning("Miniature impossible pour %s", name)
            return FileResponse(src)
        return FileResponse(out, media_type="image/webp")

    async def spa(request: Request):
        path = request.path_params.get("path", "")
        if path.startswith("api/") or path == "api":
            return JSONResponse({"error": "Not found"}, status_code=404)
        if not frontend:
            return Response("Interface non construite (frontend/dist absent).", status_code=503)
        root = Path(frontend).resolve()
        target = (root / path).resolve()
        if path and target.is_file() and str(target).startswith(str(root) + os.sep):
            return FileResponse(target)
        return FileResponse(root / "index.html")

    routes = [
        *routes_public.routes,
        *routes_app.routes,
        *routes_auth.routes,
        *routes_dashboard.routes,
        *routes_admin.routes,
        *routes_presets.routes,
        *routes_discord.routes,
        *routes_earth.routes,
        *routes_servers.routes,
        Route("/images/thumb/{name}", thumb),
        Mount("/images", app=StaticFiles(directory=images, check_dir=False), name="images"),
        Route("/{path:path}", spa),
    ]

    middleware = [Middleware(HeadersMiddleware)]
    if C.config.allowed_origin:
        middleware.append(Middleware(CORSMiddleware, allow_origins=[C.config.allowed_origin],
                                     allow_credentials=True, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                                     allow_headers=["Content-Type", "Authorization"]))

    watchers: dict[str, asyncio.Task] = {}   # suivi du journal, un par serveur

    def watch(inst) -> None:
        if start_watchers and inst.id not in watchers:
            watchers[inst.id] = logwatch.start_watcher(inst)

    async def unwatch(instance_id: str) -> None:
        task = watchers.pop(instance_id, None)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    routes_servers.watch_instance = watch
    routes_servers.unwatch_instance = unwatch

    async def start_runtime() -> None:
        if start_watchers:
            for inst in C.config.instances:
                watch(inst)
            # Appli Windows : le panel lance et surveille BeamMP-Server lui-même.
            await supervisor.start_all(C.config.instances)

    async def stop_runtime() -> None:
        for iid in list(watchers):
            await unwatch(iid)
        await supervisor.stop_all()

    async def reload_runtime() -> None:
        # Après l'assistant de premier lancement : nouveaux chemins BeamMP.
        await stop_runtime()
        appmode.apply_to_environ()
        C.set_config(C.load_config())
        await start_runtime()

    routes_app.reload_runtime = reload_runtime

    @contextlib.asynccontextmanager
    async def lifespan(app):
        init_db(C.config.db_path)
        create_initial_superadmin()
        try:
            await asyncio.to_thread(modstate.repair_map_ids, C.config.instances)
            for inst in C.config.instances:
                await asyncio.to_thread(modstate.ensure_earth_map, inst)
        except Exception:      # une réparation ratée ne doit jamais empêcher le panel de démarrer
            log.exception("Réparation des identifiants de carte impossible")
        try:
            # Zips encore rangés serveur par serveur : dans la bibliothèque commune, liés là où ils sont actifs
            await asyncio.to_thread(library.migrate, C.config.instances)
        except Exception:
            log.exception("Rangement dans la bibliothèque de mods impossible")
        await start_runtime()
        if appmode.layout():
            updater.mark_healthy_later()
        if start_watchers and updater.enabled():
            asyncio.get_running_loop().create_task(updater.check())
        if os.environ.get("BEAMMP_PANEL_OPEN") == "1":
            asyncio.get_running_loop().call_later(1.0, _open_browser)
        log.info("BeamMP Panel %s — instances : %s — base : %s", VERSION,
                 ", ".join(i.id for i in C.config.instances), C.config.db_path)
        try:
            yield
        finally:
            await stop_runtime()

    return Starlette(routes=routes, middleware=middleware, lifespan=lifespan,
                     exception_handlers={ApiError: api_error, HTTPException: http_error, Exception: server_error})
