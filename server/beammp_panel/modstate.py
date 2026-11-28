"""Activation des mods et des cartes, et édition de ServerConfig.toml."""

from __future__ import annotations

import logging
import re
import zipfile
from typing import Any

from .config import InstanceConfig
from .db import db
from .analyzer import level_candidates
from . import library
from .files import read_text, write_text

log = logging.getLogger("beammp_panel")


_has_file = library.has_file


def set_mod_active(inst: InstanceConfig, mod_id: int, active: bool) -> dict[str, Any] | None:
    """Met un mod/véhicule (jamais une carte) dans l'état voulu, fichier compris."""
    mod = db().one("SELECT * FROM mods WHERE id = ? AND instance_id = ?", [mod_id, inst.id])
    if not mod or mod["type"] == "map":
        return None
    if mod["active"] == active:
        return mod
    db().run("UPDATE mods SET active = ? WHERE id = ? AND instance_id = ?", [int(active), mod_id, inst.id])
    updated = db().one("SELECT * FROM mods WHERE id = ? AND instance_id = ?", [mod_id, inst.id])
    if updated:
        # Dans Client/ (lien vers la bibliothèque, ou le zip lui-même sans bibliothèque) ou rangé
        updated = library.place(inst, updated, active)
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


def map_zip_path(inst: InstanceConfig, mod: dict[str, Any]) -> str | None:
    """Le zip d'une carte sur le disque (bibliothèque, Client/ ou inactive_map/) ; None pour une carte officielle."""
    return library.stored_path(inst, mod)


def map_levels(inst: InstanceConfig, mod: dict[str, Any]) -> list[str]:
    """Niveaux lus dans le zip de la carte (seulement la table des fichiers : rapide même pour un gros zip)."""
    path = map_zip_path(inst, mod)
    if not path:
        return []
    try:
        with zipfile.ZipFile(path) as zf:
            names = [i.filename for i in zf.infolist() if not i.is_dir()]
    except (zipfile.BadZipFile, OSError):
        return []
    return [lvl for lvl in level_candidates(names) if valid_map_id(lvl)]


def level_of(map_id: str | None) -> str | None:
    """Nom de niveau d'un map_id enregistré (accepte « /levels/x/info.json »), None s'il est vide ou invalide."""
    return map_config_value(map_id) if map_id and valid_map_id(map_id) else None


def repair_map_ids(instances: list[InstanceConfig]) -> int:
    """Au démarrage : les cartes sans identifiant de niveau (envoyées sans, ou importées d'un zip ambigu) le reçoivent
    quand leur zip n'en contient qu'un. Sans lui, « Activer » ne pouvait rien faire. Un pack à plusieurs niveaux reste
    sans : le choix est demandé à l'activation."""
    fixed = 0
    for inst in instances:
        for mod in db().all("SELECT * FROM mods WHERE instance_id = ? AND type = 'map' AND (map_id IS NULL OR map_id = '')",
                            [inst.id]):
            levels = map_levels(inst, mod)
            if len(levels) == 1:
                db().run("UPDATE mods SET map_id = ? WHERE id = ?", [levels[0], mod["id"]])
                fixed += 1
    if fixed:
        log.info("Cartes : %d identifiant(s) de niveau retrouvé(s) dans les zips", fixed)
    return fixed


EARTH_DESCRIPTION = {"fr": "Le monde réel, généré pendant que tu roules (BeamNG.Earth).",
                     "en": "The real world, generated while you drive (BeamNG.Earth)."}


def ensure_earth_map(inst: InstanceConfig) -> bool:
    """BeamNG.Earth installé : une entrée dans les cartes (créée une fois), active si `Map =` pointe sur son niveau.
    -> True si elle vient d'être créée. Aucun fichier ne bouge ici : c'est « Activer » qui range et sort."""
    from . import earth
    from .earth_release import MOD
    from .db import dumps, now_iso
    if not earth.installed(inst) or db().one("SELECT id FROM mods WHERE instance_id = ? AND filename = ?", [inst.id, MOD]):
        return False
    m = re.search(r"^Map\s*=\s*[\"']?/?levels/([^/\"']+)", read_text(inst.beammp.config_path), re.M)
    on = bool(m and m.group(1) == earth.LEVEL)
    with db().transaction() as t:
        if on:
            t.run("UPDATE mods SET active = 0 WHERE type = 'map' AND instance_id = ?", [inst.id])
        t.run("INSERT INTO mods (instance_id, name, type, filename, description, active, map_id, image, metadata, created_at) "
              "VALUES (?, 'BeamNG.Earth', 'map', ?, ?, ?, ?, NULL, NULL, ?)",
              [inst.id, MOD, dumps(EARTH_DESCRIPTION), int(on), earth.LEVEL, now_iso()])
    log.info("Cartes : BeamNG.Earth ajouté à la liste (%s)", "active" if on else "inactive")
    return True


def is_earth_map(mod: dict[str, Any] | None) -> bool:
    from .earth_release import MOD
    return bool(mod) and mod.get("type") == "map" and mod.get("filename") == MOD


def activate_map(inst: InstanceConfig, map_id: str, mod_id: int | None = None) -> tuple[bool, Any]:
    """Active une carte : range l'ancienne, sort la nouvelle, met à jour `Map =`.

    `mod_id` désigne la carte elle-même (deux zips peuvent porter le même niveau) ; `map_id` est alors le niveau
    choisi, enregistré sur la carte. Sans `mod_id`, la carte est cherchée par son niveau (presets, ancienne API).
    Renvoie (True, carte) ou (False, message d'erreur).
    """
    if not valid_map_id(map_id):
        return False, "Identifiant de carte invalide"
    if mod_id is not None:
        new_map = db().one("SELECT * FROM mods WHERE id = ? AND type = 'map' AND instance_id = ?", [mod_id, inst.id])
    else:
        new_map = db().one("SELECT * FROM mods WHERE map_id = ? AND type = 'map' AND instance_id = ?",
                           [map_id, inst.id])
    if not new_map:
        return False, "Map not found"
    if mod_id is not None and new_map.get("map_id") != map_id:
        db().run("UPDATE mods SET map_id = ? WHERE id = ?", [map_id, new_map["id"]])
    # La config d'abord : si elle ne peut pas être écrite, ni la base ni les fichiers
    # ne bougent (avant, un échec laissait la nouvelle carte active en base et
    # l'ancienne rangée, avec un `Map =` toujours sur l'ancienne).
    content = read_text(inst.beammp.config_path)
    if content:
        write_text(inst.beammp.config_path, set_toml_key(content, "Map", format_toml_value("Map", map_config_value(map_id))))
    # Toutes les autres cartes actives, pas seulement la première : après un import
    # depuis le disque, deux cartes pouvaient l'être et l'ancienne restait dans Client/.
    # Toutes les autres cartes dont le zip est dans Client/, actives en base ou non : une base réalignée sur `Map =`
    # (status._active_map) pouvait laisser l'ancien zip dans Client/, téléchargé par les joueurs pour rien (#4521).
    for current in db().all("SELECT * FROM mods WHERE type = 'map' AND instance_id = ?", [inst.id]):
        if current["id"] == new_map["id"] or not _has_file(current):
            continue
        library.place(inst, current, False)

    with db().transaction() as t:
        t.run("UPDATE mods SET active = 0 WHERE type = 'map' AND instance_id = ?", [inst.id])
        t.run("UPDATE mods SET active = 1 WHERE id = ? AND instance_id = ?", [new_map["id"], inst.id])

    new_map = library.place(inst, new_map, True)

    # Le plugin de BeamNG.Earth suit sa carte : sous Server/ seulement quand Earth est la carte active.
    from . import earth
    earth.set_active(inst, is_earth_map(new_map))

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
