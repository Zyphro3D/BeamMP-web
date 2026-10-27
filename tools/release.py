"""Prépare une version Windows publiable : paquet complet, paquet de code, manifeste signé.

Usage : python tools/release.py [--key FICHIER] [--base URL] [--notes-fr TEXTE]
Entrée : dist/BeamMP Panel (fabriqué par build/make_windows.sh).
Sortie : dist/release/<version>/ (à joindre à la release GitHub v<version>) :
  BeamMP-Panel-<v>-win64.zip     appli complète (première installation)
  beammp-panel-code-<v>.zip      code seul (mise à jour depuis le panel)
  beammp-panel-docker-<v>.zip    installation Docker (install.sh), tirée de git (HEAD)
  latest-stable.json + .sig      manifeste signé Ed25519 (clé ~/.config/beammp-panel-release/update.key)
La clé privée ne quitte jamais cette machine : la signature se fait ici, jamais en CI.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG = ROOT / "dist" / "BeamMP Panel"
REPO_DOWNLOAD = "https://github.com/Zyphro3D/BeamMP-web/releases/download/v{v}/"


def version() -> str:
    m = re.search(r'^VERSION = "(.+)"', (ROOT / "server/beammp_panel/__init__.py").read_text(), re.M)
    return m.group(1)


def runtime_api() -> int:
    m = re.search(r"^RUNTIME_API = (\d+)", (ROOT / "server/beammp_panel/updater.py").read_text(), re.M)
    return int(m.group(1))


def changelog_notes(v: str) -> str:
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    m = re.search(rf"^## \[{re.escape(v)}\][^\n]*\n(.*?)(?=^## \[)", text, re.M | re.S)
    return m.group(1).strip() if m else ""


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def zip_dir(src: Path, dest: Path, arc_root: Path) -> None:
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in sorted(src.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                z.write(path, path.relative_to(arc_root).as_posix())


def docker_zip(dest: Path) -> None:
    """Archive du dépôt tel que commité (HEAD) : ce qu'install.sh déploie sous Linux.
    Refusée si des fichiers suivis sont modifiés, pour signer exactement le code relu."""
    def git(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True)
    if git("diff", "--quiet", "HEAD").returncode != 0:
        sys.exit("fichiers suivis modifiés : commiter avant de publier (le paquet Docker vient de HEAD)")
    if git("archive", "--format=zip", "-9", "-o", str(dest), "HEAD").returncode != 0:
        sys.exit("git archive a échoué")
    with zipfile.ZipFile(dest) as z:
        names = set(z.namelist())
    for required in ("install.sh", "docker-compose.yml", "Dockerfile", "build/update_public.b64",
                     "agent/beammp-agent.py", "server/beammp_panel/__init__.py"):
        if required not in names:
            sys.exit(f"paquet Docker incomplet : {required} absent")


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default=os.path.expanduser("~/.config/beammp-panel-release/update.key"))
    ap.add_argument("--base", help="adresse des fichiers (défaut : release GitHub v<version>)")
    ap.add_argument("--notes-fr", help="notes de version (défaut : entrée de CHANGELOG.md)")
    a = ap.parse_args()

    v = version()
    if not (PKG / "app/beammp_panel/__init__.py").is_file():
        sys.exit("dist/BeamMP Panel absent : lancer d'abord build/make_windows.sh")
    built = re.search(r'^VERSION = "(.+)"', (PKG / "app/beammp_panel/__init__.py").read_text(), re.M).group(1)
    if built != v:
        sys.exit(f"le paquet fabriqué est en {built}, le code en {v} : relancer build/make_windows.sh")

    out = ROOT / "dist" / "release" / v
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    base = (a.base or REPO_DOWNLOAD.format(v=v)).rstrip("/") + "/"

    full = out / f"BeamMP-Panel-{v}-win64.zip"
    zip_dir(PKG, full, PKG.parent)
    code = out / f"beammp-panel-code-{v}.zip"
    zip_dir(PKG / "app", code, PKG / "app")
    docker = out / f"beammp-panel-docker-{v}.zip"
    docker_zip(docker)

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    raw_key = Path(a.key).read_text().strip()
    key = Ed25519PrivateKey.from_private_bytes(base64.urlsafe_b64decode(raw_key + "=" * (-len(raw_key) % 4)))
    pub = b64(key.public_key().public_bytes_raw())
    if pub != (ROOT / "build/update_public.b64").read_text().strip():
        sys.exit("la clé privée ne correspond pas à build/update_public.b64")

    manifest = {
        "app": "beammp-panel",
        "version": v,
        "channel": "stable",
        "min_runtime": runtime_api(),
        "code": {"name": code.name, "size": code.stat().st_size, "sha256": sha(code), "url": base + code.name},
        "full": {"name": full.name, "size": full.stat().st_size, "sha256": sha(full), "url": base + full.name},
        "docker": {"name": docker.name, "size": docker.stat().st_size, "sha256": sha(docker), "url": base + docker.name},
        "notes": {"fr": a.notes_fr or changelog_notes(v)},
    }
    body = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    (out / "latest-stable.json").write_bytes(body)
    (out / "latest-stable.json.sig").write_text(b64(key.sign(body)) + "\n")
    for f in sorted(out.iterdir()):
        print(f"{f.stat().st_size:>10}  {f.name}")


if __name__ == "__main__":
    main()
