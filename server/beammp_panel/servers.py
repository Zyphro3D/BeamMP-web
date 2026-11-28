"""Serveurs ajoutés depuis le panel (bouton « Ajouter un serveur »).

Le registre est un petit fichier JSON dans DATA_DIR (servers.json), lu à
chaque chargement de la configuration et fusionné avec le serveur déclaré
par l'installation. Chaque serveur a son dossier de travail
BEAMMP_SERVERS_PATH/<id>/ (ServerConfig.toml, Resources/, Server.log) et
partage l'exécutable BeamMP-Server du serveur historique.

Un serveur supprimé n'est jamais effacé : son dossier part dans
BEAMMP_SERVERS_PATH/_archives/<id>-<date>/ et son identifiant n'est plus
réutilisé (les lignes de la base qui le portent restent donc orphelines,
sans jamais réapparaître sous un nouveau serveur).
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
import unicodedata
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .config import InstanceConfig, RunnerConfig

log = logging.getLogger("beammp_panel.servers")

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
AUTH_KEY_RE = re.compile(r"^[A-Za-z0-9-]{8,100}$")
RESERVED_IDS = {"default", "archives", "servers"}
ARCHIVES = "_archives"
FIRST_PORT = 30814
NAME_MAX = 60
_lock = threading.Lock()


def servers_root() -> Path:
    return Path(os.environ.get("BEAMMP_SERVERS_PATH", "/beammp/servers"))


def registry_path() -> Path:
    data_dir = os.environ.get("DATA_DIR", str(Path.cwd() / "data"))
    return Path(data_dir) / "servers.json"


# ── registre ──────────────────────────────────────────────────

def _valid_entry(e: Any) -> bool:
    return (isinstance(e, dict) and isinstance(e.get("id"), str) and bool(ID_RE.match(e["id"]))
            and isinstance(e.get("name"), str) and isinstance(e.get("port"), int) and 1024 <= e["port"] <= 65535)


def load_registry() -> list[dict[str, Any]]:
    path = registry_path()
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        log.exception("Registre des serveurs illisible : %s", path)
        return []
    entries = data.get("servers", []) if isinstance(data, dict) else []
    return [e for e in entries if _valid_entry(e)]


def _save_registry(entries: list[dict[str, Any]]) -> None:
    path = registry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps({"servers": entries}, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


# ── configuration d'un serveur du registre ────────────────────

def instance_for(entry: dict[str, Any], base: InstanceConfig, runner: RunnerConfig | None) -> InstanceConfig:
    """Instance d'un serveur ajouté par le panel, calquée sur le serveur historique (même hôte, même exécutable)."""
    from .config import BeamMPPaths, InstanceConfig
    d = servers_root() / entry["id"]
    return InstanceConfig(
        id=entry["id"], name=entry["name"], server_ip=base.server_ip, server_port=str(entry["port"]),
        beammp=BeamMPPaths(api_host=base.beammp.api_host, api_port=base.beammp.api_port,
                           resources_path=str(d / "Resources"), log_path=str(d / "Server.log"),
                           config_path=str(d / "ServerConfig.toml"), info_host=base.beammp.info_host),
        agent=None, server_exe=base.server_exe, workdir=str(d), runner=runner, origin="panel")


def can_add(base: InstanceConfig) -> tuple[bool, str]:
    """Le bouton n'a de sens que si le panel fait tourner les serveurs lui-même (Windows) ou via le conteneur « jeu »."""
    if base.server_exe or base.runner:
        return True, ""
    return False, "Mettez d'abord le panel à jour : l'ajout de serveurs demande le conteneur « jeu »."


# ── création / archivage ──────────────────────────────────────

def _slug(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:20].strip("-")
    return s or "serveur"


def _taken_ids(instances: list[InstanceConfig]) -> set[str]:
    taken = {i.id for i in instances} | {e["id"] for e in load_registry()} | RESERVED_IDS
    archives = servers_root() / ARCHIVES
    if archives.is_dir():   # un identifiant archivé n'est jamais réutilisé
        taken |= {p.name.rsplit("-", 2)[0] for p in archives.iterdir()}
    return taken


def new_id(name: str, instances: list[InstanceConfig]) -> str:
    base, taken = _slug(name), _taken_ids(instances)
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


def used_ports(instances: list[InstanceConfig]) -> set[int]:
    return {int(i.server_port) for i in instances if str(i.server_port).isdigit()}


def next_port(instances: list[InstanceConfig]) -> int:
    used = used_ports(instances)
    port = FIRST_PORT
    while port in used:
        port += 1
    return port


def _toml_string(value: str) -> str:
    value = re.sub(r"[\x00-\x1f\x7f]", "", value)
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _server_config(name: str, port: int, auth_key: str) -> str:
    return ("[General]\n"
            f"Name = {_toml_string(name)}\n"
            f"Port = {port}\n"
            f"AuthKey = {_toml_string(auth_key)}\n"
            'ResourceFolder = "Resources"\n'
            "MaxPlayers = 8\n"
            "MaxCars = 1\n"
            'Map = "/levels/gridmap_v2/info.json"\n'
            'Description = "BeamMP server"\n')


def validate(name: str, port: Any, auth_key: str, instances: list[InstanceConfig]) -> tuple[str, int, str]:
    """Renvoie (nom, port, clé) nettoyés ou lève ValueError avec un message affichable."""
    name = re.sub(r"\s+", " ", str(name or "")).strip()
    if not name or len(name) > NAME_MAX:
        raise ValueError(f"Nom obligatoire, {NAME_MAX} caractères au plus")
    try:
        port = int(port)
    except (TypeError, ValueError):
        raise ValueError("Port invalide")
    if not 1024 <= port <= 65535:
        raise ValueError("Le port doit être compris entre 1024 et 65535")
    if port in used_ports(instances):
        raise ValueError(f"Le port {port} est déjà utilisé par un autre serveur")
    auth_key = str(auth_key or "").strip()
    if not AUTH_KEY_RE.match(auth_key):
        raise ValueError("Clé AuthKey invalide (lettres, chiffres et tirets, à créer sur keymaster.beammp.com)")
    return name, port, auth_key


def create(name: str, port: Any, auth_key: str, instances: list[InstanceConfig]) -> dict[str, Any]:
    with _lock:
        name, port, auth_key = validate(name, port, auth_key, instances)
        sid = new_id(name, instances)
        d = servers_root() / sid
        if d.exists():
            raise ValueError(f"Le dossier {d} existe déjà")
        try:
            (d / "Resources" / "Client").mkdir(parents=True)
            (d / "Resources" / "Server").mkdir(parents=True)
            (d / "ServerConfig.toml").write_text(_server_config(name, port, auth_key), encoding="utf-8")
            (d / "Server.log").touch()
            entry = {"id": sid, "name": name, "port": port, "created": int(time.time())}
            _save_registry(load_registry() + [entry])
        except OSError:
            shutil.rmtree(d, ignore_errors=True)   # rien à moitié créé
            raise
        log.info('Serveur ajouté : "%s" (%s), port %s', name, sid, port)
        return entry


def archive(sid: str) -> str:
    """Retire un serveur ajouté par le panel ; son dossier est déplacé dans _archives. Renvoie le chemin d'archive."""
    with _lock:
        entries = load_registry()
        if not any(e["id"] == sid for e in entries):
            raise ValueError("Seuls les serveurs ajoutés depuis le panel peuvent être supprimés ici")
        src = servers_root() / sid
        dest = servers_root() / ARCHIVES / f"{sid}-{time.strftime('%Y%m%d-%H%M%S')}"
        if src.is_dir():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dest))
        _save_registry([e for e in entries if e["id"] != sid])
        log.info("Serveur %s retiré, dossier archivé dans %s", sid, dest)
        return str(dest)
