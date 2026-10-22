"""Opérations fichiers sur le dossier Resources du serveur BeamMP."""

from __future__ import annotations

import os
import shutil
from pathlib import Path


def read_text(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def write_text(path: str, content: str) -> None:
    # Écriture atomique : un plantage au milieu ne laisse jamais un
    # ServerConfig.toml à moitié écrit, que BeamMP réécrirait par défaut.
    target = Path(path)
    tmp = target.with_name(target.name + ".tmp-panel")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, target)


def delete_file(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def move_file(src: str, dest: str) -> None:
    if os.path.exists(src):
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        shutil.move(src, dest)


def ensure_dir(path: str) -> None:
    Path(path).mkdir(parents=True, exist_ok=True)


def list_files(path: str) -> list[str]:
    try:
        with os.scandir(path) as it:
            return [e.name for e in it if e.is_file()]
    except OSError:
        return []


def safe_basename(name: object) -> str | None:
    if not isinstance(name, str) or not name:
        return None
    base = os.path.basename(name)
    if not base or base != name or base in (".", ".."):
        return None
    return base


def resolve_within(root: str, name: str) -> str | None:
    """Chemin de `name` dans `root`, ou None s'il en sortirait (y compris par lien symbolique)."""
    real_root = os.path.realpath(root)
    target = os.path.realpath(os.path.join(real_root, name))
    if target != real_root and not target.startswith(real_root + os.sep):
        return None
    return target


def tail_lines(path: str, n: int, max_bytes: int = 4 * 1024 * 1024) -> list[str]:
    """Les n dernières lignes non vides, sans charger un gros Server.log en entier."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            chunk = 64 * 1024
            data = b""
            pos = size
            while pos > 0 and data.count(b"\n") <= n and len(data) < max_bytes:
                step = min(chunk, pos)
                pos -= step
                f.seek(pos)
                data = f.read(step) + data
    except OSError:
        return []
    lines = [ln for ln in data.decode("utf-8", errors="replace").split("\n") if ln]
    return lines[-n:]
