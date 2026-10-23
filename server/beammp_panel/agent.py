"""Client de beammp-agent : redémarrage et mise à jour du serveur BeamMP.

L'agent (agent/beammp-agent.py) tourne sur l'hôte, hors du panel, et
redémarre le service systemd via une liste blanche ; c'est le seul chemin
vers systemctl quand le panel est en conteneur.
"""

from __future__ import annotations

import re
import time
from typing import Any

import httpx

from . import supervisor
from .config import InstanceConfig

GITHUB_RELEASES_URL = "https://api.github.com/repos/BeamMP/BeamMP-Server/releases/latest"

# Cache court : l'API GitHub limite à 60 requêtes/h sans authentification.
_update_cache: dict[str, tuple[float, dict[str, Any]]] = {}
UPDATE_CACHE_TTL_S = 10 * 60


def _error_from(res: httpx.Response) -> str:
    try:
        return res.json().get("error") or f"HTTP {res.status_code}"
    except ValueError:
        return f"HTTP {res.status_code}"


def can_restart(inst: InstanceConfig) -> bool:
    return inst.agent is not None or bool(inst.server_exe)


def _asset(inst: InstanceConfig) -> str | None:
    """Suffixe d'asset de mise à jour : celui de l'agent, ou celui du système en supervision locale."""
    if inst.server_exe:
        return supervisor.asset_name() or None
    return inst.agent.asset if inst.agent else None


async def restart_via_agent(inst: InstanceConfig) -> tuple[bool, str | None]:
    local = supervisor.get(inst)
    if local:
        try:
            await local.restart()
        except OSError as err:
            return False, str(err)
        return True, None
    if not inst.agent:
        return False, "beammp-agent non configuré pour cette instance (BEAMMP_AGENT_URL/TOKEN/SERVICE)"
    try:
        async with httpx.AsyncClient(timeout=35) as client:  # l'agent laisse 30 s à systemctl
            res = await client.post(
                f"{inst.agent.url}/restart",
                headers={"Authorization": f"Bearer {inst.agent.token}"},
                json={"service": inst.agent.service},
            )
    except httpx.HTTPError as err:
        return False, str(err) or "beammp-agent injoignable"
    if res.status_code >= 400:
        return False, _error_from(res)
    return True, None


def _semver(raw: str) -> str | None:
    m = re.search(r"v?(\d+\.\d+\.\d+)", raw or "")
    return m.group(1) if m else None


def _disabled() -> dict[str, Any]:
    return {"enabled": False, "currentVersion": None, "latestVersion": None,
            "updateAvailable": False, "releaseUrl": None}


async def check_for_update(inst: InstanceConfig) -> dict[str, Any]:
    if not _asset(inst):
        return _disabled()
    cached = _update_cache.get(inst.id)
    if cached and time.monotonic() - cached[0] < UPDATE_CACHE_TTL_S:
        return cached[1]
    result = await _fetch_update_info(inst)
    _update_cache[inst.id] = (time.monotonic(), result)
    return result


async def _fetch_update_info(inst: InstanceConfig) -> dict[str, Any]:
    agent = inst.agent
    local = supervisor.get(inst)
    base = {"enabled": True, "currentVersion": None, "latestVersion": None,
            "updateAvailable": False, "releaseUrl": None}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            if local:
                raw_version = await local.version()
            else:
                assert agent is not None
                version_res = await client.get(f"{agent.url}/version",
                                               headers={"Authorization": f"Bearer {agent.token}"})
                if version_res.status_code >= 400:
                    return {**base, "error": _error_from(version_res)}
                raw_version = version_res.json().get("version", "")
            release_res = await client.get(GITHUB_RELEASES_URL)
    except httpx.HTTPError as err:
        return {**base, "error": str(err) or "Vérification impossible"}

    if release_res.status_code >= 400:
        return {**base, "error": f"GitHub API: HTTP {release_res.status_code}"}

    current = _semver(raw_version)
    release = release_res.json()
    latest = _semver(release.get("tag_name", ""))
    asset_name = f"BeamMP-Server.{_asset(inst)}"
    asset = next((a for a in release.get("assets", []) if a.get("name") == asset_name), None)
    result = {**base, "currentVersion": current, "latestVersion": latest,
              "releaseUrl": release.get("html_url")}
    if not asset:
        return {**result, "error": f'Aucun asset "{asset_name}" dans la dernière release'}
    result["updateAvailable"] = bool(current and latest and current != latest)
    return result


async def update_via_agent(inst: InstanceConfig) -> tuple[bool, str]:
    """Renvoie (ok, version installée ou message d'erreur)."""
    agent = inst.agent
    local = supervisor.get(inst)
    if not _asset(inst):
        return False, "Mise à jour non configurée pour cette instance (BEAMMP_AGENT_ASSET manquant)"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            release_res = await client.get(GITHUB_RELEASES_URL)
    except httpx.HTTPError:
        return False, "Impossible de contacter GitHub pour récupérer la dernière release"
    if release_res.status_code >= 400:
        return False, "Impossible de contacter GitHub pour récupérer la dernière release"
    release = release_res.json()
    asset_name = f"BeamMP-Server.{_asset(inst)}"
    asset = next((a for a in release.get("assets", []) if a.get("name") == asset_name), None)
    digest = (asset or {}).get("digest") or ""
    if not asset or not digest.startswith("sha256:"):
        return False, f'Asset "{asset_name}" introuvable ou sans empreinte sha256 dans la dernière release'

    if local:
        try:
            await local.install(asset["browser_download_url"], digest[len("sha256:"):])
        except (OSError, ValueError, RuntimeError, httpx.HTTPError) as err:
            return False, str(err)
        _update_cache.pop(inst.id, None)
        return True, release.get("tag_name", "")

    assert agent is not None
    try:
        async with httpx.AsyncClient(timeout=180) as client:  # téléchargement + installation + redémarrage
            res = await client.post(
                f"{agent.url}/update-server",
                headers={"Authorization": f"Bearer {agent.token}"},
                json={"service": agent.service, "download_url": asset["browser_download_url"],
                      "sha256": digest[len("sha256:"):]},
            )
    except httpx.HTTPError as err:
        return False, str(err) or "beammp-agent injoignable"
    if res.status_code >= 400:
        return False, _error_from(res)
    _update_cache.pop(inst.id, None)
    return True, release.get("tag_name", "")
