"""Mode appli (Windows) : paquet prêt à l'emploi, réglages sans fichier .env.

Le paquet a cette forme ; c'est elle qui active le mode appli :
    BeamMP Panel\\
        python\\          interpréteur embarqué
        app\\             code (remplacé par les mises à jour)
        _start.cmd        lanceur : applique une mise à jour, revient en arrière si besoin

Les données de l'utilisateur (base, images, réglages) vivent ailleurs, dans
%APPDATA%\\BeamMP Panel : une mise à jour ne les touche jamais.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import threading
from pathlib import Path
from typing import Any

_lock = threading.Lock()


def layout() -> tuple[Path, Path] | None:
    """(dossier d'installation, dossier app) si on tourne depuis le paquet, sinon None."""
    app = Path(__file__).resolve().parent.parent
    root = app.parent
    if app.name == "app" and (root / "python").is_dir() and (root / "_start.cmd").exists():
        return root, app
    return None


def enabled() -> bool:
    return layout() is not None or os.environ.get("BEAMMP_PANEL_APP") == "1"


def data_dir() -> Path:
    if os.environ.get("DATA_DIR"):
        return Path(os.environ["DATA_DIR"])
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    return Path(base) / "BeamMP Panel"


def settings_path() -> Path:
    return data_dir() / "settings.json"


def load_settings() -> dict[str, Any]:
    try:
        # utf-8-sig : le Bloc-notes et PowerShell ajoutent parfois un BOM en tête de fichier.
        data = json.loads(settings_path().read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(**changes: Any) -> dict[str, Any]:
    with _lock:
        data = load_settings()
        data.update(changes)
        path = settings_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
        return data


def server_paths(server_dir: str) -> dict[str, str]:
    """Chemins BeamMP déduits du dossier du serveur (là où est BeamMP-Server.exe)."""
    d = Path(server_dir)
    exe = "BeamMP-Server.exe" if sys.platform == "win32" else "BeamMP-Server"
    return {
        "BEAMMP_SERVER_EXE": str(d / exe),
        "BEAMMP_RESOURCES_PATH": str(d / "Resources"),
        "BEAMMP_LOG_PATH": str(d / "Server.log"),
        "BEAMMP_CONFIG_PATH": str(d / "ServerConfig.toml"),
    }


def apply_to_environ() -> dict[str, Any]:
    """Traduit settings.json en variables d'environnement, lues ensuite par load_config().

    Le secret des sessions est créé au premier lancement : l'utilisateur n'a
    rien à générer.
    """
    os.environ.setdefault("DATA_DIR", str(data_dir()))
    settings = load_settings()
    if not settings.get("jwt_secret"):
        settings = save_settings(jwt_secret=secrets.token_hex(32))
    os.environ["JWT_SECRET"] = settings["jwt_secret"]
    # Une seule machine : le panel n'écoute que sur ce PC, sauf choix contraire.
    os.environ.setdefault("HOST", settings.get("host", "127.0.0.1"))
    os.environ["PORT"] = str(settings.get("port") or os.environ.get("PORT") or 3000)
    os.environ.setdefault("BEAMMP_INFO_HOST", "127.0.0.1")
    if settings.get("server_name"):
        os.environ.setdefault("INSTANCE_NAME", settings["server_name"])
    if settings.get("server_dir"):
        for key, value in server_paths(settings["server_dir"]).items():
            os.environ[key] = value
    for key, env_key in (("discord_webhook", "DISCORD_WEBHOOK_URL"), ("discord_url", "DISCORD_SERVER_URL")):
        if settings.get(key):
            os.environ[env_key] = settings[key]
    return settings


def configured() -> bool:
    return bool(load_settings().get("server_dir"))
