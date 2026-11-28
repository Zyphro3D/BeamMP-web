"""Bibliothèque de mods commune aux serveurs : un seul exemplaire de chaque zip (cartes, véhicules, mods), et dans le
Client/ de chaque serveur où il est actif, un lien vers cet exemplaire. Désactiver retire le lien, le zip reste.

En service quand le panel fait tourner les serveurs lui-même (conteneur « jeu » sous Linux, supervision locale sous
Windows) et que BEAMMP_LIBRARY_PATH est posé. Sous Linux, le lien est symbolique et vise le chemin du conteneur
(/beammp/bibliotheque, monté au même endroit dans le panel et dans « jeu ») : un BeamMP-Server lancé sur l'hôte ne le
suivrait pas. Une installation restée sur l'ancien service systemd garde donc ses dossiers inactive_mod/ et
inactive_map/ par serveur, comme avant. BeamMP-Server suit les liens : il les compte, calcule leur empreinte et les
envoie aux joueurs comme des fichiers (banc du 28/11/2026).

BeamNG.Earth reste propre à chaque serveur (plugin Server/, copie de retour arrière) : jamais dans la bibliothèque.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
from typing import Any

from . import config as C
from .db import db
from .files import ensure_dir

log = logging.getLogger("beammp_panel.library")

INACTIVE_DIRS = {"map": "inactive_map", "mod": "inactive_mod", "vehicle": "inactive_mod"}
EXTENSIONS = (".zip", ".pak")


def has_file(mod: dict[str, Any]) -> bool:
    filename = mod.get("filename") or ""
    return not mod.get("is_official") and bool(filename) and not filename.startswith("__official__:")


def enabled() -> bool:
    if not C.config.library_path or not C.config.instances:
        return False
    base = C.config.instances[0]
    return bool(base.runner or base.server_exe)


def shared(mod: dict[str, Any]) -> bool:
    """Ce mod vit dans la bibliothèque (et pas dans les dossiers propres à son serveur)."""
    from .earth_release import MOD as EARTH_MOD
    return enabled() and has_file(mod) and mod["filename"] != EARTH_MOD


def lib_file(filename: str) -> str:
    return os.path.join(os.path.abspath(C.config.library_path), filename)


def client_file(inst, filename: str) -> str:
    return os.path.join(inst.beammp.resources_path, "Client", filename)


def inactive_file(inst, type_: str, filename: str) -> str:
    return os.path.join(inst.beammp.resources_path, INACTIVE_DIRS.get(type_, "inactive_mod"), filename)


def stored_path(inst, mod: dict[str, Any]) -> str | None:
    """Le zip d'un mod sur le disque, où qu'il soit ; None s'il manque (ou pour un mod officiel)."""
    if not has_file(mod):
        return None
    fn = mod["filename"]
    candidates = [lib_file(fn)] if shared(mod) else []
    types = [mod["type"]] if mod.get("type") else ["map", "mod"]      # type inconnu : les deux dossiers
    candidates += [client_file(inst, fn)] + [inactive_file(inst, ty, fn) for ty in types]
    return next((p for p in candidates if os.path.isfile(p)), None)


def users(filename: str, archived: bool = True) -> list[dict[str, Any]]:
    """Les serveurs qui ont ce zip dans leur liste de mods. Un serveur retiré (archivé) garde ses lignes : son zip
    reste dans la bibliothèque tant qu'on ne le supprime pas exprès (`archived=False` : serveurs en service seuls)."""
    rows = db().all("SELECT id, instance_id, active FROM mods WHERE filename = ?", [filename])
    if archived:
        return rows
    known = {i.id for i in C.config.instances}
    return [r for r in rows if r["instance_id"] in known]


# ── fichiers ──────────────────────────────────────────────────

def _same_content(a: str, b: str) -> bool:
    try:
        if os.path.samefile(a, b):
            return True
        sa, sb = os.stat(a), os.stat(b)
    except OSError:
        return False
    if sa.st_size != sb.st_size:
        return False
    # Même taille : l'empreinte tranche (deux zips différents peuvent avoir la même taille et la même date)

    def digest(p: str) -> str:
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    return digest(a) == digest(b)


def _link(src: str, dest: str) -> None:
    """`dest` devient un lien vers `src`. Lien symbolique sous Linux ; sous Windows lien dur (même disque), sinon copie."""
    tmp = dest + ".lien-panel"
    if os.path.lexists(tmp):
        os.unlink(tmp)
    if os.name != "nt":
        os.symlink(src, tmp)
    else:
        try:
            os.link(src, tmp)
        except OSError:
            # shortcut: copie quand le dossier du serveur est sur un autre disque que la bibliothèque (place
            # doublée) ; migrer vers un lien symbolique si le panel obtient ce droit sous Windows.
            shutil.copy2(src, tmp)
    os.replace(tmp, dest)


def _move_in(src: str, dest: str) -> None:
    """Déplace un zip dans la bibliothèque. Entre deux montages c'est une copie : faite sous un nom provisoire, pour
    qu'un arrêt en cours de route ne laisse jamais un zip tronqué sous le vrai nom (l'original reste alors en place)."""
    try:
        os.rename(src, dest)            # même montage : immédiat
        return
    except OSError:
        pass
    tmp = dest + ".part-panel"
    shutil.copy2(src, tmp)
    os.replace(tmp, dest)
    os.unlink(src)                      # seulement une fois la copie complète en place


def _free_name(filename: str) -> str:
    stem, ext = os.path.splitext(filename)
    n = 2
    while os.path.lexists(lib_file(f"{stem}-{n}{ext}")) or db().one("SELECT id FROM mods WHERE filename = ?",
                                                                    [f"{stem}-{n}{ext}"]):
        n += 1
    return f"{stem}-{n}{ext}"


def adopt(inst, mod: dict[str, Any]) -> dict[str, Any]:
    """Range dans la bibliothèque le zip que ce serveur garde encore chez lui (Client/ ou inactive_*/).

    Absent de la bibliothèque : il y est déplacé. Déjà présent et identique : le doublon est retiré. Présent mais
    différent (un autre serveur avait un zip du même nom) : il y entre sous un nouveau nom, enregistré sur ce mod.
    -> le mod, avec son nom de fichier à jour.
    """
    if not shared(mod):
        return mod
    for path in (client_file(inst, mod["filename"]), inactive_file(inst, mod["type"], mod["filename"])):
        if os.path.islink(path) or not os.path.isfile(path):
            continue
        lib = lib_file(mod["filename"])
        ensure_dir(os.path.dirname(lib))
        if not os.path.exists(lib):
            _move_in(path, lib)
        elif _same_content(path, lib):
            if not os.path.samefile(path, lib):
                os.unlink(path)
        else:
            new = _free_name(mod["filename"])
            _move_in(path, lib_file(new))
            db().run("UPDATE mods SET filename = ? WHERE id = ?", [new, mod["id"]])
            log.info("Bibliothèque : %s de %s rangé sous le nom %s (un autre zip porte déjà ce nom)",
                     mod["filename"], inst.id, new)
            mod = {**mod, "filename": new}
    return mod


def place(inst, mod: dict[str, Any], active: bool) -> dict[str, Any]:
    """Met le zip d'un mod là où son état le veut : dans Client/ s'il est actif, rangé sinon. -> le mod à jour."""
    if not has_file(mod):
        return mod
    if not shared(mod):
        client, parked = client_file(inst, mod["filename"]), inactive_file(inst, mod["type"], mod["filename"])
        src, dest = (parked, client) if active else (client, parked)
        if os.path.exists(src):
            ensure_dir(os.path.dirname(dest))
            shutil.move(src, dest)
        return mod
    mod = adopt(inst, mod)
    lib, client = lib_file(mod["filename"]), client_file(inst, mod["filename"])
    if active:
        if os.path.isfile(lib) and not os.path.isfile(client):
            if os.path.lexists(client):
                os.unlink(client)                       # lien cassé
            ensure_dir(os.path.dirname(client))
            _link(lib, client)
    elif os.path.lexists(client) and (os.path.islink(client) or os.path.isfile(lib)):
        os.unlink(client)                               # un lien (ou sa copie) : l'exemplaire reste dans la bibliothèque
    return mod


def unlink_everywhere(filename: str) -> None:
    """Retire de tous les serveurs les liens vers ce zip (avant de le supprimer : un lien cassé dans Client/ ferait
    échouer le démarrage de BeamMP-Server)."""
    for inst in C.config.instances:
        path = client_file(inst, filename)
        if os.path.islink(path) or (os.path.isfile(path) and os.path.isfile(lib_file(filename))
                                    and _same_content(path, lib_file(filename))):
            os.unlink(path)


def forget(inst, mod: dict[str, Any]) -> bool:
    """Le mod quitte ce serveur (sa ligne est déjà retirée de la base). Le zip est supprimé seulement si plus aucun
    serveur ne l'utilise. -> True si le zip a été supprimé."""
    if not has_file(mod):
        return False
    if not shared(mod):
        for path in (client_file(inst, mod["filename"]), inactive_file(inst, mod["type"], mod["filename"])):
            if os.path.lexists(path):
                os.unlink(path)
        return True
    place(inst, mod, False)
    if users(mod["filename"]):
        return False
    unlink_everywhere(mod["filename"])
    if os.path.isfile(lib_file(mod["filename"])):
        os.unlink(lib_file(mod["filename"]))
    return True


def _is_lib_copy(path: str, filename: str) -> bool:
    """Ce fichier est déjà l'exemplaire de la bibliothèque (lien dur sous Windows) : rien à ranger."""
    try:
        return os.path.samefile(path, lib_file(filename))
    except OSError:
        return False


def migrate(instances) -> int:
    """Au démarrage : les zips encore rangés serveur par serveur passent dans la bibliothèque, et chaque mod actif
    reçoit son lien. Rien n'est effacé sinon un doublon exact. -> nombre de mods rangés."""
    if not enabled():
        return 0
    moved = 0
    for inst in instances:
        for mod in db().all("SELECT * FROM mods WHERE instance_id = ?", [inst.id]):
            if not shared(mod):
                continue
            fn = mod["filename"]
            had_local = any(os.path.isfile(p) and not os.path.islink(p) and not _is_lib_copy(p, fn)
                            for p in (client_file(inst, fn), inactive_file(inst, mod["type"], fn)))
            try:
                place(inst, mod, bool(mod["active"]))
            except OSError as err:
                log.error("Bibliothèque : %s de %s non rangé : %s", fn, inst.id, err)
                continue
            moved += had_local
    if moved:
        log.info("Bibliothèque : %d zip(s) rangé(s) dans %s", moved, C.config.library_path)
    return moved


def listing() -> list[dict[str, Any]]:
    """Le contenu de la bibliothèque, avec pour chaque zip les serveurs qui l'utilisent."""
    root = os.path.abspath(C.config.library_path)
    try:
        files = sorted(e.name for e in os.scandir(root) if e.is_file(follow_symlinks=False)
                       and e.name.lower().endswith(EXTENSIONS))
    except OSError:
        return []
    names = {i.id: i.name for i in C.config.instances}
    out = []
    for fn in files:
        rows = db().all("SELECT * FROM mods WHERE filename = ? ORDER BY id", [fn])
        known = [r for r in rows if r["instance_id"] in names]
        first = known[0] if known else (rows[0] if rows else None)
        out.append({
            "filename": fn,
            "size": os.path.getsize(os.path.join(root, fn)),
            "name": first["name"] if first else os.path.splitext(fn)[0],
            "type": first["type"] if first else None,
            "image": first["image"] if first else None,
            "metadata": first["metadata"] if first else None,
            "servers": [{"id": r["instance_id"], "name": names[r["instance_id"]], "active": bool(r["active"])}
                        for r in known],
            "archived": sorted({r["instance_id"] for r in rows if r["instance_id"] not in names}),
        })
    return out
