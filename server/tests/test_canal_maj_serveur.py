"""Canal de mise à jour du serveur BeamMP (28/11/2026) : stable, préversion, version précise."""
from __future__ import annotations

import httpx
import pytest

from beammp_panel import agent
from beammp_panel import config as C

URL = "/api/i/default/server"
ASSET = "BeamMP-Server.debian.13.x86_64"


def rel(tag, pre=False, draft=False, asset=True, digest=True, date="2026-09-03"):
    a = [{"name": ASSET, "browser_download_url": f"https://github.com/BeamMP/BeamMP-Server/releases/download/{tag}/{ASSET}",
          "digest": "sha256:" + "a" * 64 if digest else None}] if asset else []
    return {"tag_name": tag, "prerelease": pre, "draft": draft, "html_url": f"https://github.com/r/{tag}",
            "published_at": date + "T10:00:00Z", "assets": a}


RELEASES = [rel("v3.9.4", pre=True), rel("v3.9.3"), rel("v3.9.2"), rel("v3.9.1", pre=True), rel("v4.0.0", draft=True),
            rel("v3.8.0", asset=False)]


@pytest.fixture()
def serveur(env, monkeypatch):
    """Instance avec agent, faux agent (version 3.9.3) et faux GitHub ; g['installe'] = ce que l'agent a reçu."""
    monkeypatch.setenv("BEAMMP_AGENT_URL", "http://agent.test:8787")
    monkeypatch.setenv("BEAMMP_AGENT_TOKEN", "jeton")
    monkeypatch.setenv("BEAMMP_AGENT_SERVICE", "beammp")
    monkeypatch.setenv("BEAMMP_AGENT_ASSET", ASSET.split(".", 1)[1])
    C.set_config(C.load_config())
    g = {"version": "v3.9.3", "installe": None}

    def handler(request: httpx.Request):
        if request.url.host == "api.github.com":
            return httpx.Response(200, json=RELEASES)
        if request.url.path == "/version":
            return httpx.Response(200, json={"version": g["version"]})
        if request.url.path == "/update-server":
            import json
            g["installe"] = json.loads(request.content)["download_url"]
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)
    real = httpx.AsyncClient

    def client(*a, **kw):
        kw["transport"] = httpx.MockTransport(handler)
        return real(*a, **kw)
    monkeypatch.setattr(agent.httpx, "AsyncClient", client)
    agent._update_cache.clear()
    return g


@pytest.fixture()
def adm(serveur):
    from starlette.testclient import TestClient
    from beammp_panel.app import create_app
    from .conftest import login
    with TestClient(create_app(start_watchers=False, frontend_dir="")) as c:
        yield login(c)


def test_stable_par_defaut_ignore_la_preversion(adm):
    r = adm.get(f"{URL}/update-check").json()
    assert r["channel"] == "stable" and r["latestVersion"] == "3.9.3" and r["updateAvailable"] is False
    assert [v["version"] for v in r["versions"]] == ["3.9.4", "3.9.3", "3.9.2", "3.9.1"]   # ni brouillon ni release sans binaire
    assert r["versions"][0]["prerelease"] is True


def test_canal_preversion(adm, serveur):
    r = adm.put(f"{URL}/update-channel", json={"channel": "prerelease"}).json()
    assert r["latestVersion"] == "3.9.4" and r["latestPrerelease"] is True and r["updateAvailable"] is True
    assert adm.post(f"{URL}/update").json()["version"] == "v3.9.4"
    assert serveur["installe"].endswith("/v3.9.4/" + ASSET)


def test_version_precise_retour_arriere(adm, serveur):
    r = adm.put(f"{URL}/update-channel", json={"channel": "pinned", "version": "3.9.2"}).json()
    assert r["channel"] == "pinned" and r["pinnedVersion"] == "3.9.2"
    assert r["updateAvailable"] is True and r["downgrade"] is True
    adm.post(f"{URL}/update")
    assert serveur["installe"].endswith("/v3.9.2/" + ASSET)


def test_version_precise_refusee(adm):
    for v in ("3.8.0", "4.0.0", "9.9.9", None, "../x"):
        assert adm.put(f"{URL}/update-channel", json={"channel": "pinned", "version": v}).status_code == 400, v
    assert adm.put(f"{URL}/update-channel", json={"channel": "nightly"}).status_code == 400


def test_retour_au_stable(adm):
    adm.put(f"{URL}/update-channel", json={"channel": "pinned", "version": "3.9.2"})
    r = adm.put(f"{URL}/update-channel", json={"channel": "stable", "version": "3.9.2"}).json()
    assert r["channel"] == "stable" and r["pinnedVersion"] is None and r["latestVersion"] == "3.9.3"


def test_reserve_aux_admins(client, serveur):
    assert client.put(f"{URL}/update-channel", json={"channel": "prerelease"}).status_code in (401, 403)
