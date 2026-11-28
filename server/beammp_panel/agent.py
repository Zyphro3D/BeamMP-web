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
from .db import db

# Toutes les releases (pas seulement « latest », qui ne renvoie que la dernière stable) : le canal de mise à jour
# choisit dedans. Brouillons jamais proposés.
GITHUB_RELEASES_URL = "https://api.github.com/repos/BeamMP/BeamMP-Server/releases?per_page=30"
CHANNELS = ("stable", "prerelease", "pinned")
VERSIONS_LISTED = 15

# Cache court : l'API GitHub limite à 60 requêtes/h sans authentification.
_update_cache: dict[str, tuple[float, dict[str, Any]]] = {}
UPDATE_CACHE_TTL_S = 10 * 60


def _error_from(res: httpx.Response) -> str:
    try:
        return res.json().get("error") or f"HTTP {res.status_code}"
    except ValueError:
        return f"HTTP {res.status_code}"


def can_restart(inst: InstanceConfig) -> bool:
    return inst.agent is not None or bool(inst.server_exe) or inst.runner is not None


def _asset(inst: InstanceConfig) -> str | None:
    """Suffixe d'asset de mise à jour : supervision locale (Windows), conteneur « jeu », ou agent."""
    if inst.server_exe:
        return supervisor.asset_name() or None
    if inst.runner:
        return inst.runner.asset or supervisor.linux_asset() or None
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
        return False, "Redémarrage non configuré pour cette instance (BEAMMP_AGENT_URL/TOKEN/SERVICE)"
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


def _key(version: str) -> tuple[int, ...]:
    return tuple(int(x) for x in version.split("."))


def get_channel(inst: InstanceConfig) -> tuple[str, str | None]:
    """Canal de mise à jour du serveur : (stable | prerelease | pinned, version épinglée). Stable par défaut."""
    rows = {r["key"]: r["value"] for r in db().all(
        "SELECT key, value FROM server_settings WHERE instance_id = ? AND key IN ('update_channel', 'update_version')",
        [inst.id])}
    channel = rows.get("update_channel", "stable")
    if channel not in CHANNELS:
        channel = "stable"
    version = rows.get("update_version") if channel == "pinned" else None
    return ("stable", None) if channel == "pinned" and not version else (channel, version)


def set_channel(inst: InstanceConfig, channel: str, version: str | None) -> None:
    with db().transaction() as t:
        for key, value in (("update_channel", channel), ("update_version", version or "")):
            t.run("INSERT INTO server_settings (instance_id, key, value) VALUES (?, ?, ?) "
                  "ON CONFLICT(instance_id, key) DO UPDATE SET value = excluded.value", [inst.id, key, value])
    _update_cache.pop(inst.id, None)


def _usable(releases: list[dict[str, Any]], asset_name: str) -> list[dict[str, Any]]:
    """Releases installables (pas de brouillon, version lisible, binaire de ce système avec son empreinte), plus récente d'abord."""
    out = []
    for r in releases if isinstance(releases, list) else []:
        version = _semver(r.get("tag_name", ""))
        asset = next((a for a in r.get("assets", []) if a.get("name") == asset_name), None)
        if r.get("draft") or not version or not asset or not str(asset.get("digest") or "").startswith("sha256:"):
            continue
        out.append({**r, "_version": version, "_asset": asset})
    return sorted(out, key=lambda r: _key(r["_version"]), reverse=True)


def _target(usable: list[dict[str, Any]], channel: str, pinned: str | None) -> dict[str, Any] | None:
    """Stable : la plus récente non préversion. Préversion : la plus récente, préversions comprises (une stable plus
    récente l'emporte). Version précise : celle-là, même plus ancienne (retour arrière)."""
    if channel == "pinned":
        return next((r for r in usable if r["_version"] == pinned), None)
    pool = usable if channel == "prerelease" else [r for r in usable if not r.get("prerelease")]
    return pool[0] if pool else None


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
    asset_name = f"BeamMP-Server.{_asset(inst)}"
    usable = _usable(release_res.json(), asset_name)
    channel, pinned = get_channel(inst)
    target = _target(usable, channel, pinned)
    stable = _target(usable, "stable", None)
    result = {**base, "currentVersion": current, "channel": channel, "pinnedVersion": pinned,
              "latestStable": stable["_version"] if stable else None,
              "versions": [{"version": r["_version"], "prerelease": bool(r.get("prerelease")),
                            "date": str(r.get("published_at") or "")[:10]} for r in usable[:VERSIONS_LISTED]]}
    if not target:
        why = (f"Version {pinned} introuvable (ou sans binaire {asset_name})" if channel == "pinned"
               else f'Aucun asset "{asset_name}" dans les releases')
        return {**result, "error": why}
    latest = target["_version"]
    result.update(latestVersion=latest, latestPrerelease=bool(target.get("prerelease")),
                  releaseUrl=target.get("html_url"),
                  updateAvailable=bool(current and current != latest),
                  downgrade=bool(current and _key(latest) < _key(current)))
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
        return False, "Impossible de contacter GitHub pour récupérer les releases"
    if release_res.status_code >= 400:
        return False, "Impossible de contacter GitHub pour récupérer les releases"
    asset_name = f"BeamMP-Server.{_asset(inst)}"
    channel, pinned = get_channel(inst)
    release = _target(_usable(release_res.json(), asset_name), channel, pinned)
    if not release:
        return False, (f"Version {pinned} introuvable ou sans binaire {asset_name} avec empreinte sha256" if channel == "pinned"
                       else f'Asset "{asset_name}" introuvable ou sans empreinte sha256 dans les releases')
    asset = release["_asset"]
    digest = asset["digest"]

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
