"""Conteneur « jeu » : plusieurs serveurs, un exécutable commun, pilotage HTTP par jeton."""

from __future__ import annotations

import asyncio
import hashlib
import json
import stat
import sys
import time
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from beammp_panel import runner, supervisor
from beammp_panel.config import BeamMPPaths, InstanceConfig, RunnerConfig

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="exécutable factice en script shebang")

TOKEN = "t" * 40
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def script(version: str, crash: bool = False) -> str:
    body = "sys.exit(3)\n" if crash else (
        "open('Server.log', 'a').write('ALL SYSTEMS STARTED ' + os.getcwd() + '\\n')\n"
        "time.sleep(600)\n")
    return (f"#!{sys.executable}\n"
            "import os, sys, time\n"
            f"if '--version' in sys.argv: print('BeamMP-Server v{version}'); sys.exit(0)\n" + body)


def make_exe(path: Path, version: str = "3.9.4") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(script(version))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


def make_server(d: Path, port: int) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    (d / "ServerConfig.toml").write_text(f"[General]\nPort = {port}\n")
    return d


@pytest.fixture
def setup(tmp_path, monkeypatch):
    main, servers = tmp_path / "main", tmp_path / "servers"
    make_server(main, 30814)
    make_exe(main / "BeamMP-Server")
    make_server(servers / "event", 30815)
    monkeypatch.setenv("BEAMMP_RUNNER_TOKEN", TOKEN)
    monkeypatch.setenv("BEAMMP_MAIN_DIR", str(main))
    monkeypatch.setenv("BEAMMP_SERVERS_PATH", str(servers))
    monkeypatch.delenv("BEAMMP_SERVER_EXE", raising=False)
    supervisor._servers.clear()
    yield main, servers
    asyncio.run(supervisor.stop_all())


def wait_for(pred, timeout: float = 10) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.2)
    return False


def test_runner_refuses_bad_token_and_paths(setup):
    with TestClient(runner.create_app()) as client:
        assert client.get("/health").json() == {"ok": True}
        assert client.get("/servers").status_code == 401
        assert client.get("/servers", headers={"Authorization": "Bearer nope"}).status_code == 401
        assert client.post("/servers/..%2Fetc/start", headers=AUTH).status_code in (400, 404)
        assert client.post("/servers/Bad_Id/start", headers=AUTH).status_code == 400
        assert client.post("/servers/missing/start", headers=AUTH).status_code == 404
        assert client.post("/servers/default/forget", headers=AUTH).status_code == 400


def test_runner_short_token_refused(setup, monkeypatch):
    monkeypatch.setenv("BEAMMP_RUNNER_TOKEN", "court")
    with pytest.raises(SystemExit):
        runner.create_app()


def test_two_servers_share_one_exe_in_their_own_folder(setup):
    main, servers = setup
    with TestClient(runner.create_app()) as client:
        for sid in ("default", "event"):
            r = client.post(f"/servers/{sid}/start", headers=AUTH)
            assert r.status_code == 200 and r.json()["running"], r.text
        assert wait_for(lambda: (main / "Server.log").is_file() and (servers / "event" / "Server.log").is_file())
        # Chaque serveur tourne dans SON dossier (ServerConfig.toml, Resources, Server.log).
        assert str(servers / "event") in (servers / "event" / "Server.log").read_text()
        assert str(main) in (main / "Server.log").read_text()
        assert json.loads((servers / "_runner.json").read_text())["wanted"] == ["default", "event"]
        assert client.get("/version", headers=AUTH).json()["version"] == "BeamMP-Server v3.9.4"

        assert client.post("/servers/event/forget", headers=AUTH).json() == {"ok": True}
        assert "event" not in client.get("/servers", headers=AUTH).json()["servers"]
        assert json.loads((servers / "_runner.json").read_text())["wanted"] == ["default"]

    # Redémarrage du conteneur : le serveur voulu repart tout seul.
    supervisor._servers.clear()
    with TestClient(runner.create_app()) as client:
        state = client.get("/servers", headers=AUTH).json()
        assert state["servers"]["default"]["running"] and "event" not in state["servers"]
        r = client.post("/servers/default/stop", headers=AUTH).json()
        assert not r["running"] and not r["wanted"]
        assert json.loads((servers / "_runner.json").read_text())["wanted"] == []


def _serve_binary(monkeypatch, content: bytes) -> str:
    """Les téléchargements du superviseur reçoivent `content` (pas de réseau dans les tests)."""
    real = httpx.AsyncClient
    transport = httpx.MockTransport(lambda req: httpx.Response(200, content=content))
    monkeypatch.setattr(supervisor.httpx, "AsyncClient",
                        lambda *a, **kw: real(*a, **{**kw, "transport": transport}))
    return hashlib.sha256(content).hexdigest()


def _instances(main: Path, servers: Path) -> list[supervisor.ServerProcess]:
    out = []
    for sid, d in (("default", main), ("event", servers / "event")):
        inst = InstanceConfig(id=sid, name=sid, server_ip="", server_port="", beammp=BeamMPPaths("", 0, "", "", "", ""),
                              agent=None, server_exe=str(main / "BeamMP-Server"), workdir=str(d))
        out.append(supervisor.get(inst))
    return out


def test_shared_update_restarts_every_server(setup, monkeypatch):
    main, servers = setup
    monkeypatch.setattr(supervisor, "HEALTHY_AFTER_S", 1)
    sha = _serve_binary(monkeypatch, script("3.9.5").encode())
    url = supervisor.RELEASE_URL_PREFIX + "v3.9.5/BeamMP-Server.debian.13.x86_64"

    async def run():
        a, b = _instances(main, servers)
        await a.start()
        await b.start()
        pids = (a.proc.pid, b.proc.pid)
        await b.install(url, sha)
        assert a.running() and b.running()
        assert (a.proc.pid, b.proc.pid) != pids and a.proc.pid != pids[0] and b.proc.pid != pids[1]
        assert await a.version() == "BeamMP-Server v3.9.5"
    asyncio.run(run())


def test_shared_update_rolls_back_for_everyone(setup, monkeypatch):
    main, servers = setup
    monkeypatch.setattr(supervisor, "HEALTHY_AFTER_S", 1)
    sha = _serve_binary(monkeypatch, script("9.9.9", crash=True).encode())
    url = supervisor.RELEASE_URL_PREFIX + "v9.9.9/BeamMP-Server.debian.13.x86_64"

    async def run():
        a, b = _instances(main, servers)
        await a.start()
        await b.start()
        with pytest.raises(RuntimeError):
            await a.install(url, sha)
        assert a.running() and b.running()
        assert await b.version() == "BeamMP-Server v3.9.4"
    asyncio.run(run())


def test_remote_server_talks_to_runner(setup, monkeypatch):
    """Le panel pilote le conteneur par RemoteServer (même interface que la supervision locale)."""
    app = runner.create_app()
    with TestClient(app) as client:
        real = httpx.AsyncClient
        transport = httpx.ASGITransport(app=app)
        monkeypatch.setattr(supervisor.httpx, "AsyncClient",
                            lambda *a, **kw: real(*a, **{**kw, "transport": transport}))
        inst = InstanceConfig(id="event", name="Event", server_ip="", server_port="30815",
                              beammp=BeamMPPaths("", 0, "", "", "", ""), agent=None,
                              runner=RunnerConfig(url="http://jeu", token=TOKEN))
        sp = supervisor.get(inst)
        assert isinstance(sp, supervisor.RemoteServer)

        async def run():
            await sp.start()
            assert (await sp.fetch_state())["running"]
            await sp.restart()
            assert (await sp.fetch_state())["running"]
            assert await sp.version() == "BeamMP-Server v3.9.4"
            await sp.forget()
            assert not (await sp.fetch_state()).get("running")
            with pytest.raises(ValueError):
                await sp.install("https://evil.example/x", "0" * 64)
            bad = supervisor.RemoteServer(InstanceConfig(
                id="event", name="", server_ip="", server_port="", beammp=None, agent=None,  # type: ignore[arg-type]
                runner=RunnerConfig(url="http://jeu", token="mauvais" * 6)))
            with pytest.raises(OSError):
                await bad.start()
            assert (await bad.fetch_state())["unreachable"]
        asyncio.run(run())
        assert client.get("/servers", headers=AUTH).status_code == 200
