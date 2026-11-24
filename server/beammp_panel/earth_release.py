"""BeamNG.Earth : version installée sur le serveur et mise à jour depuis les releases GitHub du fork.

Une release publie BeamNG.Earth-BeamMP-Server-<version>.zip : Resources/Client/beamng_earth.zip (le mod envoyé aux
joueurs, qui porte sa version dans lua/ge/extensions/beamngEarth/release.lua) et Resources/Server/BeamNGEarth/main.lua
(le plugin). La mise à jour télécharge ce zip depuis la release, vérifie son empreinte sha256 (donnée par l'API
GitHub : sans elle, rien n'est installé), vérifie qu'il contient bien la version annoncée, puis remplace le mod et le
plugin en gardant la version précédente (*.previous) pour un retour arrière. Rien d'autre n'est touché :
settings.json, le stock, les packs restent. Le serveur doit ensuite redémarrer (les joueurs reçoivent le mod à leur
connexion).
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import tempfile
import threading
import time
import zipfile
from typing import Any

import httpx

from .config import InstanceConfig
from .earth import plugin_dir

REPO = os.environ.get("EARTH_RELEASES_REPO", "Zyphro3D/BeamNG.Earth")
API = "https://api.github.com/repos/{repo}/releases/latest"
MOD = "beamng_earth.zip"
RELEASE_LUA = "lua/ge/extensions/beamngEarth/release.lua"
ZIP_MOD = "Resources/Client/beamng_earth.zip"
ZIP_PLUGIN = "Resources/Server/BeamNGEarth/main.lua"
MAX_BYTES = 1024 * 1024 * 1024
CACHE_TTL_S = 10 * 60
_VERSION_RE = re.compile(r"""return\s*['"]([0-9A-Za-z.+\-]{1,64})['"]""")

_lock = threading.Lock()
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_installed_cache: dict[str, tuple[tuple[int, float], str | None]] = {}


def mod_path(inst: InstanceConfig) -> str:
    return os.path.join(inst.beammp.resources_path, "Client", MOD)


def plugin_path(inst: InstanceConfig) -> str:
    return os.path.join(plugin_dir(inst), "main.lua")


def version_in_mod(data_or_path: Any) -> str | None:
    """La version d'un beamng_earth.zip (chemin ou octets), lue dans release.lua ; None si absente."""
    try:
        src = io.BytesIO(data_or_path) if isinstance(data_or_path, bytes) else data_or_path
        with zipfile.ZipFile(src) as z:
            text = z.read(RELEASE_LUA).decode("utf-8", "replace")
    except (OSError, KeyError, zipfile.BadZipFile):
        return None
    m = _VERSION_RE.search(text)
    return m.group(1) if m else None


def installed_version(inst: InstanceConfig) -> str | None:
    path = mod_path(inst)
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (st.st_size, st.st_mtime)
    hit = _installed_cache.get(path)
    if not hit or hit[0] != key:
        hit = (key, version_in_mod(path))
        _installed_cache[path] = hit
    return hit[1]


def previous_version(inst: InstanceConfig) -> str | None:
    prev = mod_path(inst) + ".previous"
    return version_in_mod(prev) if os.path.isfile(prev) and os.path.isfile(plugin_path(inst) + ".previous") else None


def _asset_name(version: str) -> str:
    return f"BeamNG.Earth-BeamMP-Server-{version}.zip"


def parse_release(data: dict[str, Any], repo: str = REPO) -> dict[str, Any]:
    """La réponse de l'API GitHub -> {version, asset{url,size,sha256}, notesUrl} ; asset None si introuvable."""
    tag = str(data.get("tag_name") or "")
    version = tag[1:] if tag.startswith("v") else tag
    asset = None
    want = _asset_name(version)
    prefix = f"https://github.com/{repo}/releases/download/"
    for a in data.get("assets") or []:
        if not isinstance(a, dict) or a.get("name") != want:
            continue
        url, digest = str(a.get("browser_download_url") or ""), str(a.get("digest") or "")
        if url.startswith(prefix) and re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            asset = {"name": want, "url": url, "size": int(a.get("size") or 0), "sha256": digest[7:]}
    return {"version": version or None, "asset": asset, "notesUrl": data.get("html_url"),
            "published": data.get("published_at")}


async def latest(force: bool = False) -> dict[str, Any]:
    now = time.time()
    hit = _cache.get(REPO)
    if hit and not force and now - hit[0] < CACHE_TTL_S:
        return hit[1]
    try:
        async with httpx.AsyncClient(timeout=15, headers={"Accept": "application/vnd.github+json",
                                                          "User-Agent": "BeamMP-Panel"}) as client:
            r = await client.get(API.format(repo=REPO))
        if r.status_code != 200:
            out = {"error": f"GitHub : HTTP {r.status_code}"}
        else:
            out = parse_release(r.json())
    except (httpx.HTTPError, ValueError) as e:
        out = {"error": f"GitHub injoignable : {type(e).__name__}"}
    _cache[REPO] = (now, out)
    return out


async def status(inst: InstanceConfig, force: bool = False) -> dict[str, Any]:
    rel = await latest(force)
    installed = installed_version(inst)
    lat = rel.get("version")
    return {"repo": REPO, "installed": installed, "previous": previous_version(inst), "latest": lat,
            "updateAvailable": bool(lat and installed and lat != installed and rel.get("asset")),
            "notesUrl": rel.get("notesUrl"), "published": rel.get("published"), "size": (rel.get("asset") or {}).get("size"),
            "error": rel.get("error") or (None if rel.get("asset") or not lat else
                                          f"La release {lat} n'a pas de {_asset_name(lat)} avec empreinte")}


def _replace_keeping_previous(path: str, data: bytes) -> None:
    """Écrit data à path par un fichier voisin renommé dessus ; l'ancien devient path.previous."""
    folder = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".earth-", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if os.path.exists(path):
            os.replace(path, path + ".previous")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def check_bundle(data: bytes, version: str) -> tuple[bytes, bytes]:
    """Le zip serveur d'une release -> (mod, plugin) ; ValueError s'il ne contient pas ce qu'il annonce."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = set(z.namelist())
            if ZIP_MOD not in names or ZIP_PLUGIN not in names:
                raise ValueError("le zip ne contient pas le mod et le plugin attendus")
            mod, plugin = z.read(ZIP_MOD), z.read(ZIP_PLUGIN)
    except zipfile.BadZipFile:
        raise ValueError("fichier téléchargé illisible (pas un zip)")
    found = version_in_mod(mod)
    if found != version:
        raise ValueError(f"le mod du zip est en version {found}, pas {version}")
    if b"BeamNG.Earth" not in plugin[:4096]:
        raise ValueError("le plugin du zip n'est pas celui de BeamNG.Earth")
    return mod, plugin


async def install(inst: InstanceConfig) -> dict[str, Any]:
    """Télécharge et installe la dernière release ; -> {installed, previous}. RuntimeError avec un message sinon."""
    if not _lock.acquire(blocking=False):
        raise RuntimeError("Une mise à jour est déjà en cours")
    try:
        rel = await latest(force=True)
        asset, version = rel.get("asset"), rel.get("version")
        if rel.get("error") or not asset or not version:
            raise RuntimeError(rel.get("error") or "Aucune release installable")
        if asset["size"] > MAX_BYTES:
            raise RuntimeError("Fichier de release trop gros")
        h, buf = hashlib.sha256(), bytearray()
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=120), follow_redirects=True,
                                     headers={"User-Agent": "BeamMP-Panel"}) as client:
            async with client.stream("GET", asset["url"]) as r:
                if r.status_code != 200:
                    raise RuntimeError(f"Téléchargement : HTTP {r.status_code}")
                async for chunk in r.aiter_bytes(1024 * 1024):
                    buf += chunk
                    h.update(chunk)
                    if len(buf) > MAX_BYTES:
                        raise RuntimeError("Fichier de release trop gros")
        if h.hexdigest() != asset["sha256"]:
            raise RuntimeError("Empreinte sha256 différente de celle de la release : rien n'est installé")
        try:
            mod, plugin = check_bundle(bytes(buf), version)
        except ValueError as e:
            raise RuntimeError(f"Release refusée : {e}")
        before = installed_version(inst)
        # le plugin d'abord : un nouveau plugin lit les anciens réglages ; le mod ensuite (chargé au redémarrage)
        _replace_keeping_previous(plugin_path(inst), plugin)
        _replace_keeping_previous(mod_path(inst), mod)
        return {"installed": version, "previous": before}
    finally:
        _lock.release()


def restore_previous(inst: InstanceConfig) -> str:
    """Remet la version précédente (mod et plugin) ; la version actuelle devient la précédente. -> sa version."""
    with _lock:
        pairs = [(mod_path(inst), mod_path(inst) + ".previous"), (plugin_path(inst), plugin_path(inst) + ".previous")]
        if not all(os.path.isfile(p) for _, p in pairs):
            raise RuntimeError("Aucune version précédente à remettre")
        version = version_in_mod(pairs[0][1])
        for cur, prev in pairs:
            tmp = cur + ".swap"
            os.replace(cur, tmp)
            os.replace(prev, cur)
            os.replace(tmp, prev)
        return version or "?"
