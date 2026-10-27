"""Activation des mods et des cartes, et édition de ServerConfig.toml."""

from __future__ import annotations

import os
import re
from typing import Any

from .config import InstanceConfig
from .db import db
from .files import ensure_dir, move_file, read_text, write_text


def _has_file(mod: dict[str, Any]) -> bool:
    filename = mod.get("filename") or ""
    return not mod.get("is_official") and bool(filename) and not filename.startswith("__official__:")


def set_mod_active(inst: InstanceConfig, mod_id: int, active: bool) -> dict[str, Any] | None:
    """Met un mod/véhicule (jamais une carte) dans l'état voulu, fichier compris."""
    mod = db().one("SELECT * FROM mods WHERE id = ? AND instance_id = ?", [mod_id, inst.id])
    if not mod or mod["type"] == "map":
        return None
    if mod["active"] == active:
        return mod
    db().run("UPDATE mods SET active = ? WHERE id = ? AND instance_id = ?", [int(active), mod_id, inst.id])
    updated = db().one("SELECT * FROM mods WHERE id = ? AND instance_id = ?", [mod_id, inst.id])
    if updated and _has_file(updated):
        active_dir = os.path.join(inst.beammp.resources_path, "Client")
        inactive_dir = os.path.join(inst.beammp.resources_path, "inactive_mod")
        ensure_dir(inactive_dir)
        src_dir, dest_dir = (inactive_dir, active_dir) if active else (active_dir, inactive_dir)
        move_file(os.path.join(src_dir, updated["filename"]), os.path.join(dest_dir, updated["filename"]))
    return updated


def map_config_value(map_id: str) -> str:
    """Valeur de `Map =` pour un map_id, en tolérant un chemin complet déjà saisi.

    Le formulaire d'ajout de carte proposait « /levels/x/info.json » en
    exemple : saisi tel quel, il donnait /levels//levels/x/info.json/info.json.
    """
    m = re.match(r"^/?levels/([^/]+)(?:/info\.json)?/?$", map_id.strip())
    level = m.group(1) if m else map_id.strip().strip("/")
    # La valeur finit dans ServerConfig.toml : un guillemet ou un retour à la
    # ligne y injecterait des clés hors liste blanche (AllowGuests, Port…).
    if not MAP_LEVEL_RE.match(level):
        raise ValueError(f"Identifiant de carte invalide : {map_id!r}")
    return f"/levels/{level}/info.json"


MAP_LEVEL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")


def valid_map_id(map_id: str) -> bool:
    try:
        map_config_value(map_id)
        return True
    except ValueError:
        return False


def activate_map(inst: InstanceConfig, map_id: str) -> tuple[bool, Any]:
    """Active une carte : range l'ancienne, sort la nouvelle, met à jour `Map =`.

    Renvoie (True, carte) ou (False, message d'erreur).
    """
    if not valid_map_id(map_id):
        return False, "Identifiant de carte invalide"
    new_map = db().one("SELECT * FROM mods WHERE map_id = ? AND type = 'map' AND instance_id = ?",
                       [map_id, inst.id])
    if not new_map:
        return False, "Map not found"
    client_dir = os.path.join(inst.beammp.resources_path, "Client")
    inactive_dir = os.path.join(inst.beammp.resources_path, "inactive_map")

    current = db().one("SELECT * FROM mods WHERE type = 'map' AND active = 1 AND instance_id = ? LIMIT 1", [inst.id])
    if current and current["id"] != new_map["id"] and _has_file(current):
        src = os.path.join(client_dir, current["filename"])
        if os.path.exists(src):
            ensure_dir(inactive_dir)
            move_file(src, os.path.join(inactive_dir, current["filename"]))

    with db().transaction() as t:
        t.run("UPDATE mods SET active = 0 WHERE type = 'map' AND instance_id = ?", [inst.id])
        t.run("UPDATE mods SET active = 1 WHERE id = ? AND instance_id = ?", [new_map["id"], inst.id])

    if _has_file(new_map):
        src = os.path.join(inactive_dir, new_map["filename"])
        if os.path.exists(src):
            ensure_dir(client_dir)
            move_file(src, os.path.join(client_dir, new_map["filename"]))

    content = read_text(inst.beammp.config_path)
    if content:
        write_text(inst.beammp.config_path, set_toml_key(content, "Map", format_toml_value("Map", map_config_value(map_id))))
    return True, db().one("SELECT * FROM mods WHERE id = ?", [new_map["id"]])


# ── ServerConfig.toml ─────────────────────────────────────────

# Clés exposées au panel. Port, AuthKey, IP, ResourceFolder,
# InformationPacket et AllowGuests restent dehors exprès : une faute de
# frappe coupe le serveur ou divulgue la clé AuthKey.
ALLOWED_CONFIG_KEYS = ["Name", "Description", "MaxPlayers", "MaxCars", "Private", "LogChat", "Tags", "Debug"]

CONFIG_KEY_TOML_TYPE = {
    "Private": "boolean", "LogChat": "boolean", "Debug": "boolean",
    "MaxPlayers": "number", "MaxCars": "number",
    "Name": "string", "Description": "string", "Tags": "string",
}


CONTROL_CHARS_RE = re.compile("[\x00-\x1f\x7f\x85\u2028\u2029]")


def format_toml_value(key: str, value: str) -> str:
    kind = CONFIG_KEY_TOML_TYPE.get(key, "string")
    if kind == "boolean":
        return "true" if value == "true" else "false"
    if kind == "number":
        try:
            n = float(value)
        except ValueError:
            return "0"
        if n != n or n in (float("inf"), float("-inf")) or n < 0:
            return "0"
        return str(int(n)) if n.is_integer() else str(n)
    # Aucun caractère de contrôle dans une chaîne TOML d'une ligne : un retour
    # à la ligne ajouterait une clé, un \x00 ou \x0b rendrait le fichier invalide.
    value = CONTROL_CHARS_RE.sub("", value)
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def read_config_entries(content: str) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line in content.split("\n"):
        m = re.match(r"^(\w+)\s*=\s*(.+)$", line.rstrip("\r"))
        # Même liste blanche qu'à l'écriture : le fichier contient la clé
        # AuthKey, qui ne doit jamais atteindre le navigateur.
        if m and m.group(1) in ALLOWED_CONFIG_KEYS:
            entries[m.group(1)] = re.sub(r"^[\"']|[\"']$", "", m.group(2).strip()).strip()
    return entries


def set_toml_key(content: str, key: str, toml_value: str) -> str:
    """Remplace `key = …`, ou l'ajoute dans la section [General] si elle manque.

    La v2 l'ajoutait en fin de fichier, donc souvent dans [Misc], où BeamMP
    ne la lit pas.
    """
    pattern = re.compile(rf"^{re.escape(key)}\s*=.*$", re.M)
    if pattern.search(content):
        return pattern.sub(lambda _: f"{key} = {toml_value}", content, count=1)
    lines = content.rstrip("\n").split("\n")
    try:
        start = next(i for i, ln in enumerate(lines) if ln.strip() == "[General]")
    except StopIteration:
        return content.rstrip("\n") + f"\n{key} = {toml_value}\n"
    end = next((i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("[")), len(lines))
    while end > start + 1 and not lines[end - 1].strip():
        end -= 1
    lines.insert(end, f"{key} = {toml_value}")
    return "\n".join(lines) + "\n"
