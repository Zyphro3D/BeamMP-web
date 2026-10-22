"""Point d'entrée : `python -m beammp_panel` (ou l'exécutable empaqueté)."""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

import uvicorn

from . import VERSION
from . import config as C


def main() -> None:
    parser = argparse.ArgumentParser(prog="beammp-panel", description="BeamMP Panel")
    parser.add_argument("--env", default=os.environ.get("ENV_FILE", ".env"), help="fichier .env à charger")
    parser.add_argument("--version", action="version", version=VERSION)
    args = parser.parse_args()

    C.load_dotenv(Path(args.env))
    C.set_config(C.load_config())
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    from .app import check_startup, create_app
    check_startup()
    forwarded = "*" if C.config.trust_proxy == "true" else (C.config.trust_proxy or "127.0.0.1")
    uvicorn.run(create_app(), host=C.config.host, port=C.config.port, log_level="info",
                proxy_headers=False, forwarded_allow_ips=forwarded, server_header=False)


if __name__ == "__main__":
    main()
