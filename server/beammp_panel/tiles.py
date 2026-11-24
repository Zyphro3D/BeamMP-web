"""Relais des tuiles OpenStreetMap pour la carte des joueurs BeamNG.Earth.

La CSP du panel n'autorise que ses propres images (img-src 'self') : le navigateur demande donc les tuiles au panel,
qui les prend chez OpenStreetMap et les garde sur disque. Règles d'usage d'OSM
(https://operations.osmfoundation.org/policies/tiles/) : un User-Agent qui identifie l'appli, un cache local d'au moins
7 jours (14 ici), peu de requêtes (carte réservée aux admins, limite par IP), l'attribution affichée sous la carte.
OSM ne voit que l'adresse du serveur et les tuiles demandées, jamais qui regarde.
"""

from __future__ import annotations

import os
import time

import httpx

from . import config as C

TILE_URL = os.environ.get("EARTH_TILE_URL", "https://tile.openstreetmap.org/{z}/{x}/{y}.png")
USER_AGENT = "BeamMP-Panel/3 (BeamNG.Earth player map; +https://github.com/Zyphro3D/BeamMP-web)"
MAX_ZOOM = 17
CACHE_TTL_S = 14 * 24 * 3600
MAX_TILE_BYTES = 512 * 1024


def valid(z: int, x: int, y: int) -> bool:
    return 0 <= z <= MAX_ZOOM and 0 <= x < 2 ** z and 0 <= y < 2 ** z


def cache_path(z: int, x: int, y: int) -> str:
    return os.path.join(C.config.data_dir, "tiles", str(z), str(x), f"{y}.png")


def cached(z: int, x: int, y: int) -> bytes | None:
    path = cache_path(z, x, y)
    try:
        if time.time() - os.path.getmtime(path) > CACHE_TTL_S:
            return None
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


def store(z: int, x: int, y: int, data: bytes) -> None:
    path = cache_path(z, x, y)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


async def fetch(z: int, x: int, y: int) -> bytes | None:
    """La tuile (cache d'abord) ; None si OSM ne la donne pas."""
    data = cached(z, x, y)
    if data is not None:
        return data
    try:
        async with httpx.AsyncClient(timeout=10, headers={"User-Agent": USER_AGENT}) as client:
            r = await client.get(TILE_URL.format(z=z, x=x, y=y))
    except httpx.HTTPError:
        return None
    if r.status_code != 200 or not r.content.startswith(b"\x89PNG") or len(r.content) > MAX_TILE_BYTES:
        return None
    store(z, x, y, r.content)
    return r.content
