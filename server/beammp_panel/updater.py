"""Mise à jour du panel depuis le panel (appli Windows et Docker), sur le modèle de ZCoach.

Un manifeste JSON SIGNÉ (Ed25519) publié avec chaque release GitHub annonce
la dernière version. Le panel vérifie la signature avec la clé publique
embarquée, télécharge le paquet de code (dossier beammp_panel/, interface
comprise), contrôle son SHA-256 et le range dans app.new. Au redémarrage,
_start.cmd échange app et app.new ; si la nouvelle version n'atteint pas
l'état « sain » (20 s de fonctionnement), le démarrage suivant revient à
l'ancienne. Les données (%APPDATA%\\BeamMP Panel) ne sont jamais touchées.
Rien n'est envoyé hors de la requête HTTPS elle-même.

En Docker (installation par install.sh), le panel n'a aucun droit sur
l'hôte : le bouton dépose seulement une DEMANDE (update/request.json).
L'unité systemd posée par install.sh relance alors le script installé, qui
revérifie la signature avec sa propre clé, refuse toute version plus
ancienne, reconstruit le conteneur et revient en arrière si le panel ne
répond plus. L'avancement arrive dans update/status.json.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path
from typing import Any

import httpx

from . import VERSION, appmode, ed25519

log = logging.getLogger("beammp_panel.updater")

APP_ID = "beammp-panel"
UPDATE_BASE = "https://github.com/Zyphro3D/BeamMP-web/releases/latest/download/"
DOWNLOAD_PREFIX = "https://github.com/Zyphro3D/BeamMP-web/releases/download/"
RUNTIME_API = 1          # à incrémenter quand Python ou une dépendance change : le code seul ne suffit plus
MAX_MANIFEST = 256 * 1024
MAX_CODE_ZIP = 40 * 1024 * 1024
HEALTHY_AFTER_S = 20

try:
    from ._updkey import PUBLIC_KEY_B64
except ImportError:
    PUBLIC_KEY_B64 = os.environ.get("BEAMMP_PANEL_UPDKEY", "")

# Dossier partagé avec l'hôte (docker-compose.yml) : demande, avancement, présence de l'agent.
UPDATE_DIR = Path(os.environ.get("BEAMMP_PANEL_UPDATE_DIR", "/app/update"))
STATUS_STALE_S = 2 * 3600

STATE: dict[str, Any] = {"phase": "idle", "current": VERSION, "version": None, "notes": {},
                         "size": 0, "error": "", "fullRequired": False, "checked": 0, "enabled": False}
_lock = threading.Lock()


def parse(v: str) -> tuple:
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?", str(v).strip())
    if not m:
        raise ValueError(f"version invalide : {v!r}")
    pre = m.group(4)
    key = tuple(int(m.group(i)) for i in (1, 2, 3))
    pk = (1,) if pre is None else (0,) + tuple((0, int(x), "") if x.isdigit() else (1, 0, x) for x in pre.split("."))
    return key + (pk,)


def newer(a: str, b: str) -> bool:
    return parse(a) > parse(b)


def _b64d(s: str) -> bytes:
    s = s.strip()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_manifest(raw: bytes, sig_b64: str, pub_b64: str | None = None) -> dict[str, Any]:
    pub = pub_b64 or PUBLIC_KEY_B64
    if not pub:
        raise ValueError("clé de signature absente : mises à jour désactivées")
    if not ed25519.verify(_b64d(pub), raw, _b64d(sig_b64)):
        raise ValueError("signature du manifeste invalide")
    m = json.loads(raw)
    if m.get("app") != APP_ID:
        raise ValueError("manifeste d'une autre application")
    parse(m["version"])
    return m


def docker_mode() -> bool:
    """Installation Docker faite par install.sh : l'agent de l'hôte s'est signalé."""
    return appmode.layout() is None and (UPDATE_DIR / "agent.json").is_file()


def enabled() -> bool:
    return bool(PUBLIC_KEY_B64) and (appmode.layout() is not None or docker_mode())


def host_status() -> dict[str, Any]:
    """Avancement écrit par install.sh sur l'hôte (Docker), et demande encore en attente."""
    st: dict[str, Any] = {}
    try:
        raw = json.loads((UPDATE_DIR / "status.json").read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            st = {k: raw[k] for k in ("phase", "message", "version", "updated_at") if k in raw}
    except (OSError, ValueError):
        pass
    if st and time.time() - float(st.get("updated_at") or 0) > STATUS_STALE_S:
        st = {}
    return {"host": st, "pending": (UPDATE_DIR / "request.json").is_file()}


def base_url() -> str:
    b = os.environ.get("BEAMMP_PANEL_UPDATE_BASE") or appmode.load_settings().get("update_base") or UPDATE_BASE
    return b if b.endswith("/") else b + "/"


def _local_http(url: str) -> bool:
    # HTTP non chiffré seulement vers ce PC (tests, miroir local).
    return re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?/", url) is not None


async def _fetch(client: httpx.AsyncClient, url: str, limit: int) -> bytes:
    if not url.startswith("https://") and not _local_http(url):
        raise OSError(f"adresse non sécurisée : {url}")
    async with client.stream("GET", url) as res:
        res.raise_for_status()
        data = bytearray()
        async for chunk in res.aiter_bytes(256 * 1024):
            data += chunk
            if len(data) > limit:
                raise OSError("fichier trop volumineux")
    return bytes(data)


async def check() -> dict[str, Any]:
    """Interroge les releases ; renvoie l'état (jamais d'exception)."""
    with _lock:
        STATE.update(phase="checking", error="", enabled=enabled())
    if not STATE["enabled"]:
        with _lock:
            STATE.update(phase="disabled")
        return dict(STATE)
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True,
                                     headers={"User-Agent": f"BeamMP-Panel/{VERSION}"}) as client:
            raw = await _fetch(client, base_url() + "latest-stable.json", MAX_MANIFEST)
            sig = (await _fetch(client, base_url() + "latest-stable.json.sig", 4096)).decode("ascii")
        m = verify_manifest(raw, sig)
        skipped = appmode.load_settings().get("skip_version")
        with _lock:
            STATE["checked"] = int(time.time())
            if m["version"] == skipped:
                # Version déjà essayée, qui n'a pas démarré : on ne la repropose pas.
                STATE.update(phase="current", version=VERSION, notes={}, fullRequired=False,
                             error=f"La version {skipped} n'a pas démarré sur ce PC : elle est ignorée")
            elif newer(m["version"], VERSION):
                STATE.update(phase="available", version=m["version"], notes=m.get("notes") or {},
                             size=int((m.get("code") or {}).get("size", 0)),
                             fullRequired=not docker_mode() and int(m.get("min_runtime", 0)) > RUNTIME_API,
                             manifest=m)
            else:
                STATE.update(phase="current", version=m["version"], notes={}, fullRequired=False)
    except httpx.HTTPStatusError as err:
        # 404 : la dernière release ne publie pas (encore) de manifeste signé.
        message = ("Aucune version publiée pour la mise à jour automatique pour l'instant"
                   if err.response.status_code == 404 else f"Serveur de mises à jour : HTTP {err.response.status_code}")
        log.warning("Mise à jour : %s", message)
        with _lock:
            STATE.update(phase="error", error=message)
    except Exception as err:  # réseau, signature, format : affiché, jamais bloquant
        log.warning("Mise à jour : contrôle impossible (%s)", err)
        with _lock:
            STATE.update(phase="error", error=str(err)[:200])
    return public_state()


def public_state() -> dict[str, Any]:
    with _lock:
        state = {k: v for k, v in STATE.items() if k != "manifest"}
    state["docker"] = docker_mode()
    if state["docker"]:
        state |= host_status()
    return state


def extract_code(data: bytes, dest: Path) -> None:
    """Décompresse le paquet de code dans dest, en refusant tout chemin qui en sortirait."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    root = dest.resolve()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            target = (dest / info.filename).resolve()
            if target != root and not str(target).startswith(str(root) + os.sep):
                raise ValueError(f"chemin refusé dans le paquet : {info.filename}")
        zf.extractall(dest)
    if not (dest / "beammp_panel" / "__init__.py").is_file():
        raise ValueError("paquet de code incomplet")


def request_host_update() -> dict[str, Any]:
    """Docker : dépose la demande lue par l'agent de l'hôte (écriture atomique).
    Seule la version est transmise ; l'hôte retélécharge et revérifie tout."""
    with _lock:
        m = STATE.get("manifest")
    if not m or not docker_mode():
        raise ValueError("aucune mise à jour à installer")
    if not (m.get("docker") or {}).get("name"):
        raise ValueError("cette version ne publie pas de paquet Docker")
    version = m["version"]
    parse(version)
    tmp = UPDATE_DIR / f".request-{os.getpid()}.tmp"
    tmp.write_text(json.dumps({"version": version, "requested_at": int(time.time())}))
    os.replace(tmp, UPDATE_DIR / "request.json")
    with _lock:
        STATE.update(phase="requested", error="")
    return public_state()


async def install() -> dict[str, Any]:
    """Télécharge et prépare la version annoncée (app.new) ; le redémarrage l'active."""
    if docker_mode():
        return request_host_update()
    lay = appmode.layout()
    with _lock:
        m = STATE.get("manifest")
    if not lay or not m:
        raise ValueError("aucune mise à jour à installer")
    if int(m.get("min_runtime", 0)) > RUNTIME_API:
        raise ValueError("cette version demande de retélécharger l'appli complète")
    code = m.get("code") or {}
    url = code.get("url", "")
    # Le manifeste est signé, mais on limite quand même l'origine du paquet :
    # releases du dépôt, ou le même miroir que le manifeste.
    if not (url.startswith(DOWNLOAD_PREFIX) or url.startswith(base_url())):
        raise ValueError("adresse du paquet inattendue")
    with _lock:
        STATE.update(phase="downloading", error="")
    try:
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            data = await _fetch(client, url, MAX_CODE_ZIP)
        if hashlib.sha256(data).hexdigest() != code.get("sha256"):
            raise ValueError("empreinte du paquet différente : téléchargement refusé")
        root, _app = lay
        extract_code(data, root / "app.new")
        appmode.save_settings(pending_version=m["version"])
    except Exception as err:
        with _lock:
            STATE.update(phase="error", error=str(err)[:200])
        raise
    with _lock:
        STATE.update(phase="ready")
    return public_state()


def restart_app() -> None:
    """Relance le panel par _start.cmd (qui active app.new) puis quitte ce processus."""
    lay = appmode.layout()
    if not lay:
        return
    root, _ = lay
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
    subprocess.Popen(["cmd", "/c", str(root / "_start.cmd")], cwd=str(root), creationflags=flags,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os._exit(0)


def mark_healthy_later() -> None:
    """Après 20 s de fonctionnement, la version courante est confirmée : plus de retour arrière."""
    lay = appmode.layout()
    if not lay:
        return
    rolled = lay[0] / "app.rolledback"
    if rolled.exists():
        # _start.cmd vient de revenir à la version précédente : la version
        # installée n'a pas démarré, on la note pour ne plus la proposer.
        failed = appmode.load_settings().get("pending_version")
        appmode.save_settings(skip_version=failed, pending_version=None)
        rolled.unlink(missing_ok=True)
        log.warning("Retour à la version %s : la version %s n'a pas démarré", VERSION, failed)

    def confirm() -> None:
        time.sleep(HEALTHY_AFTER_S)
        root, _ = lay
        marker = root / "app.swapped"
        if marker.exists():
            marker.unlink(missing_ok=True)
            shutil.rmtree(root / "app.old", ignore_errors=True)
            log.info("Mise à jour confirmée : version %s", VERSION)
    threading.Thread(target=confirm, daemon=True, name="update-healthy").start()
