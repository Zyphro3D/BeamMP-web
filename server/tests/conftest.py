"""Fixtures : un panel complet sur des dossiers temporaires, sans réseau."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from PIL import Image
from starlette.testclient import TestClient

from beammp_panel import activity, logwatch, status
from beammp_panel import config as C
from beammp_panel.security import limiter

SECRET = "test-secret-0123456789abcdef0123456789"  # gitleaks:allow (valeur de test)
CONFIG_TOML = """[General]
Name = "Serveur test"
Port = 30814
AuthKey = "NE-DOIT-JAMAIS-SORTIR"
Map = "/levels/gridmap_v2/info.json"
MaxPlayers = 8
Private = true
Description = "desc"

[Misc]
ImScaredOfUpdates = false
"""


@pytest.fixture()
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    res = tmp_path / "res"
    (res / "Client").mkdir(parents=True)
    (tmp_path / "logs").mkdir()
    (tmp_path / "logs" / "Server.log").write_text("")
    (tmp_path / "ServerConfig.toml").write_text(CONFIG_TOML)
    for key, value in {
        "JWT_SECRET": SECRET,
        "DATA_DIR": str(tmp_path / "data"),
        "BEAMMP_RESOURCES_PATH": str(res),
        "BEAMMP_LOG_PATH": str(tmp_path / "logs" / "Server.log"),
        "BEAMMP_CONFIG_PATH": str(tmp_path / "ServerConfig.toml"),
        "BEAMMP_INFO_HOST": "",
        "SUPERADMIN_USERNAME": "boss",
        "SUPERADMIN_PASSWORD": "motdepasse-boss",
    }.items():
        monkeypatch.setenv(key, value)
    for key in ("INSTANCES", "BEAMMP_SERVER_IP", "BEAMMP_SERVER_PORT", "BEAMMP_AGENT_URL", "DISCORD_WEBHOOK_URL"):
        monkeypatch.delenv(key, raising=False)
    C.set_config(C.load_config())
    status.reset()
    logwatch.reset()
    activity.reset()
    limiter.reset()
    return tmp_path


@pytest.fixture()
def client(env):
    from beammp_panel.app import create_app
    app = create_app(start_watchers=False, frontend_dir="")
    with TestClient(app) as c:
        yield c


def login(client: TestClient, username: str = "boss", password: str = "motdepasse-boss") -> TestClient:
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return client


@pytest.fixture()
def admin(client):
    return login(client)


def png_bytes(color=(200, 30, 30), size=(64, 48)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def make_zip(files: dict[str, bytes | str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data if isinstance(data, bytes) else data.encode())
    return buf.getvalue()


def vehicle_zip() -> bytes:
    return make_zip({
        "vehicles/dynamo/info.json": json.dumps({"Name": "Gavril Dynamo", "Brand": "Gavril", "Body Style": "Coupe",
                                                 "Type": "Car", "Years": {"min": 1960, "max": 1965}}),
        # SJSON : virgules absentes et commentaire, comme dans certains fichiers du jeu
        "vehicles/dynamo/info_sport.json": '{"Configuration": "Sport (M)" "Drivetrain": "RWD" // commentaire\n'
                                           '"Power": 180 "Fuel Type": "Gasoline", "Transmission": "Manual",}',
        "vehicles/dynamo/race.pc": "{}",
        "vehicles/dynamo/default.png": png_bytes(),
    })


def map_zip(level: str = "black_hills") -> bytes:
    return make_zip({
        f"levels/{level}/info.json": json.dumps({"title": "Black Hills", "size": [2048, 2048]}),
        f"levels/{level}/main.level.json": "{}",
        f"levels/{level}/preview.jpg": png_bytes((10, 120, 10)),
    })
