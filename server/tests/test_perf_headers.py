"""Lighthouse du 28/11/2026 sur beammp.zyphro.fr : jeton CSP par réponse, durées de cache, miniatures des grilles."""
from __future__ import annotations

import io
import re
from pathlib import Path

from PIL import Image

from beammp_panel import config as C


def test_csp_nonce_change_a_chaque_reponse(client):
    a = client.get("/api/instances").headers["content-security-policy"]
    b = client.get("/api/instances").headers["content-security-policy"]
    na, nb = (re.search(r"script-src 'self' 'nonce-([\w-]{16,})'", h) for h in (a, b))
    assert na and nb and na.group(1) != nb.group(1)
    assert "unsafe-inline" not in a.split("script-src", 1)[1].split(";", 1)[0]   # le jeton ne rouvre pas l'inline


def test_cache_api_jamais(client):
    assert "cache-control" not in client.get("/api/instances").headers


def test_miniature_reduite_et_mise_en_cache(client):
    images = Path(C.config.images_path)
    buf = io.BytesIO(); Image.new("RGB", (640, 480), (10, 120, 200)).save(buf, "WEBP"); (images / "carte.webp").write_bytes(buf.getvalue())
    r = client.get("/images/thumb/carte.webp")
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    assert Image.open(io.BytesIO(r.content)).size == (400, 300)
    assert r.headers["cache-control"] == "public, max-age=604800"
    assert (images / ".thumbs" / "carte.webp").is_file()
    full = client.get("/images/carte.webp")
    assert full.status_code == 200 and Image.open(io.BytesIO(full.content)).size == (640, 480)


def test_miniature_petite_image_gardee(client):
    images = Path(C.config.images_path)
    Image.new("RGB", (200, 100)).save(images / "petit.png")
    assert Image.open(io.BytesIO(client.get("/images/thumb/petit.png").content)).size == (200, 100)


def test_miniature_noms_refuses(client):
    for nom in ("..%2Fsecret.webp", ".thumbs.webp", "absent.webp", "x.txt"):
        assert client.get(f"/images/thumb/{nom}").status_code == 404, nom


def test_cache_page_et_build(env, tmp_path):
    from starlette.testclient import TestClient
    from beammp_panel.app import create_app
    front = tmp_path / "front"; (front / "assets").mkdir(parents=True)
    (front / "index.html").write_text("<!doctype html><title>x</title>")
    (front / "assets" / "index-abc123.js").write_text("console.log(1)")
    with TestClient(create_app(start_watchers=False, frontend_dir=str(front))) as c:
        assert c.get("/").headers["cache-control"] == "no-cache"
        assert c.get("/dashboard").headers["cache-control"] == "no-cache"          # route de l'appli : même page
        assert c.get("/assets/index-abc123.js").headers["cache-control"] == "public, max-age=31536000, immutable"
        assert c.get("/assets/index-ancien.js").headers["cache-control"] == "no-cache"   # build précédent : jamais figé un an
