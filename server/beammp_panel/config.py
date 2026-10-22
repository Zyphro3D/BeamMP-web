"""Configuration — lue dans l'environnement (et un éventuel fichier .env).

Mêmes variables que la v2 pour qu'un .env existant marche tel quel ; les
variables POSTGRES_* ne servent plus qu'à l'outil de migration
(tools/migrate_from_postgres.py). Nouvelles variables :
  DATA_DIR          dossier des données (base SQLite, images par défaut)
  DB_PATH           chemin de la base SQLite (défaut DATA_DIR/panel.db)
  BEAMMP_INFO_HOST  hôte interrogé en direct sur le port de jeu (paquet I)
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def load_dotenv(path: Path) -> None:
    """Charge un fichier .env simple (CLE=valeur) sans écraser l'environnement."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def env_flag_default_true(name: str) -> bool:
    # Même sémantique que la v2 : activé sauf si la variable vaut "false".
    return os.environ.get(name) != "false"


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


@dataclass
class AgentConfig:
    url: str
    token: str
    service: str
    # Suffixe d'asset GitHub release BeamMP-Server (ex. "debian.13.x86_64") ;
    # None = mise à jour désactivée, le redémarrage reste disponible.
    asset: str | None


@dataclass
class BeamMPPaths:
    api_host: str
    api_port: int
    resources_path: str
    log_path: str
    config_path: str
    info_host: str


@dataclass
class InstanceConfig:
    id: str
    name: str
    server_ip: str
    server_port: str
    beammp: BeamMPPaths
    agent: AgentConfig | None


@dataclass
class DiscordConfig:
    webhook_url: str = ""
    webhook_restart: str = ""
    webhook_players: str = ""
    webhook_mods: str = ""
    server_url: str = ""
    notify_join: bool = True
    notify_leave: bool = True
    notify_mod_upload: bool = True
    notify_map_change: bool = True
    notify_restart: bool = True


@dataclass
class Config:
    port: int
    host: str
    jwt_secret: str
    allowed_origin: str
    images_path: str
    db_path: str
    data_dir: str
    cookie_secure: bool
    trust_proxy: str
    server_description: str
    kofi_url: str
    discord: DiscordConfig
    instances: list[InstanceConfig] = field(default_factory=list)


def _build_agent(service: str, asset: str) -> AgentConfig | None:
    url = env("BEAMMP_AGENT_URL")
    token = env("BEAMMP_AGENT_TOKEN")
    if url and token and service:
        return AgentConfig(url=url.rstrip("/"), token=token, service=service, asset=asset or None)
    return None


def _parse_instances() -> list[InstanceConfig]:
    raw = env("INSTANCES")
    if not raw:
        return [InstanceConfig(
            id="default",
            name=env("INSTANCE_NAME", "BeamMP Server"),
            server_ip=env("BEAMMP_SERVER_IP"),
            server_port=env("BEAMMP_SERVER_PORT"),
            beammp=BeamMPPaths(
                api_host=env("BEAMMP_API_HOST", "localhost"),
                api_port=env_int("BEAMMP_API_PORT", 4444),
                resources_path=env("BEAMMP_RESOURCES_PATH", "/beammp/resources"),
                log_path=env("BEAMMP_LOG_PATH", "/beammp/logs/Server.log"),
                config_path=env("BEAMMP_CONFIG_PATH", "/beammp/ServerConfig.toml"),
                info_host=env("BEAMMP_INFO_HOST", "127.0.0.1"),
            ),
            agent=_build_agent(env("BEAMMP_AGENT_SERVICE"), env("BEAMMP_AGENT_ASSET")),
        )]

    # Multi-instance : INSTANCES=main,event → INSTANCE_MAIN_*, INSTANCE_EVENT_*
    instances = []
    for iid in (s.strip() for s in raw.split(",")):
        if not iid:
            continue
        p = f"INSTANCE_{iid.upper()}_"
        instances.append(InstanceConfig(
            id=iid,
            name=env(f"{p}NAME", iid),
            server_ip=env(f"{p}SERVER_IP"),
            server_port=env(f"{p}SERVER_PORT"),
            beammp=BeamMPPaths(
                api_host=env(f"{p}BEAMMP_API_HOST", "localhost"),
                api_port=env_int(f"{p}BEAMMP_API_PORT", 4444),
                resources_path=env(f"{p}BEAMMP_RESOURCES_PATH", "/beammp/resources"),
                log_path=env(f"{p}BEAMMP_LOG_PATH", "/beammp/logs/Server.log"),
                config_path=env(f"{p}BEAMMP_CONFIG_PATH", "/beammp/ServerConfig.toml"),
                info_host=env(f"{p}BEAMMP_INFO_HOST", "127.0.0.1"),
            ),
            agent=_build_agent(env(f"{p}AGENT_SERVICE"), env(f"{p}AGENT_ASSET")),
        ))
    return instances


def load_config() -> Config:
    data_dir = env("DATA_DIR", str(Path.cwd() / "data"))
    return Config(
        port=env_int("PORT", 3000),
        host=env("HOST", "0.0.0.0"),
        jwt_secret=env("JWT_SECRET", "change-me"),
        allowed_origin=env("ALLOWED_ORIGIN"),
        images_path=env("IMAGES_PATH", str(Path(data_dir) / "images")),
        db_path=env("DB_PATH", str(Path(data_dir) / "panel.db")),
        data_dir=data_dir,
        cookie_secure=env("COOKIE_SECURE") == "true",
        trust_proxy=env("TRUST_PROXY"),
        server_description=env("SERVER_DESCRIPTION"),
        kofi_url=env("KOFI_URL"),
        discord=DiscordConfig(
            webhook_url=env("DISCORD_WEBHOOK_URL"),
            webhook_restart=env("DISCORD_WEBHOOK_RESTART"),
            webhook_players=env("DISCORD_WEBHOOK_PLAYERS"),
            webhook_mods=env("DISCORD_WEBHOOK_MODS"),
            server_url=env("DISCORD_SERVER_URL"),
            notify_join=env_flag_default_true("DISCORD_NOTIFY_JOIN"),
            notify_leave=env_flag_default_true("DISCORD_NOTIFY_LEAVE"),
            notify_mod_upload=env_flag_default_true("DISCORD_NOTIFY_MOD_UPLOAD"),
            notify_map_change=env_flag_default_true("DISCORD_NOTIFY_MAP_CHANGE"),
            notify_restart=env_flag_default_true("DISCORD_NOTIFY_RESTART"),
        ),
        instances=_parse_instances(),
    )


# Instance unique du processus — remplacée par les tests via set_config().
config: Config = load_config()


def set_config(new: Config) -> None:
    global config
    config = new


def get_instance(instance_id: str) -> InstanceConfig | None:
    return next((i for i in config.instances if i.id == instance_id), None)
