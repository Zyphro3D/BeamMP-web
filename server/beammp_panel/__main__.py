"""Point d'entrée : `python -m beammp_panel` (ou l'exécutable empaqueté)."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

import uvicorn

from . import VERSION
from . import config as C


def already_running(url: str) -> bool:
    import urllib.request
    try:
        with urllib.request.urlopen(url + "api/info", timeout=1.5) as r:
            return r.headers.get("x-beammp-panel-version") is not None
    except OSError:
        return False


def port_free(host: str, port: int) -> bool:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def pick_port(host: str, wanted: int) -> int:
    """Premier port libre à partir de `wanted` (un autre logiciel du PC peut déjà utiliser 3000)."""
    for port in range(wanted, wanted + 100):
        if port_free(host, port):
            return port
    raise SystemExit(f"[FATAL] aucun port libre entre {wanted} et {wanted + 99}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="beammp-panel", description="BeamMP Panel")
    parser.add_argument("--env", default=os.environ.get("ENV_FILE", ".env"), help="fichier .env à charger")
    parser.add_argument("--version", action="version", version=VERSION)
    parser.add_argument("--open", action="store_true", help="ouvrir le panel dans le navigateur au démarrage")
    args = parser.parse_args()

    from . import appmode
    if appmode.enabled():
        # Appli Windows : réglages dans %APPDATA%\BeamMP Panel\settings.json, pas de .env.
        appmode.apply_to_environ()
        if sys.stderr is None or sys.stdout is None:
            # Lancé sans console (pythonw) : sans flux de sortie, le moindre
            # message de journal ferait échouer le démarrage. Tout va au fichier.
            stream = open(appmode.data_dir() / "panel.log", "a", encoding="utf-8", buffering=1)
            sys.stdout = sys.stderr = stream
        logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
        os.environ.setdefault("BEAMMP_PANEL_OPEN", "1" if args.open else "0")
    else:
        C.load_dotenv(Path(args.env))
        logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    C.set_config(C.load_config())

    from .app import check_startup, create_app, local_url
    if already_running(local_url()):
        # Deuxième lancement : le panel tourne déjà, on ouvre simplement la page.
        if args.open:
            import webbrowser
            webbrowser.open(local_url())
        return
    check_startup()
    if appmode.enabled() and not port_free(C.config.host, C.config.port):
        # Appli : le port est pris par un autre programme (le panel lui-même
        # aurait répondu plus haut). On en prend un libre et on le garde.
        port = pick_port(C.config.host, C.config.port)
        logging.getLogger("beammp_panel").warning("Port %s occupé par un autre programme : le panel utilise %s",
                                                  C.config.port, port)
        appmode.save_settings(port=port)
        C.config.port = port
    forwarded = "*" if C.config.trust_proxy == "true" else (C.config.trust_proxy or "127.0.0.1")
    uvicorn.run(create_app(), host=C.config.host, port=C.config.port, log_level="info",
                proxy_headers=False, forwarded_allow_ips=forwarded, server_header=False)


if __name__ == "__main__":
    main()
