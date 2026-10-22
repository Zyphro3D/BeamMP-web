"""Suivi de Server.log : arrivées et départs des joueurs, alertes, démarrage.

Lecture par sondage du chemin (toutes les 2 s) plutôt que par inotify :
BeamMP recrée Server.log à chaque démarrage (nouvel inode), ce qui rendrait
une surveillance inotify muette pour toujours après un redémarrage.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from datetime import datetime
from typing import Any

from . import config as C
from .activity import log_activity
from .config import InstanceConfig
from .db import db, now_iso
from .discord import send_discord_notification
from .files import tail_lines
from .status import mark_server_alive, player_joined, player_left

log = logging.getLogger("beammp_panel.logwatch")

POLL_S = 2.0

# Préfixe d'une ligne BeamMP : « [jj/mm/aa HH:MM:SS(.mmm)] (thread )[NIVEAU] ».
LINE_RE = re.compile(
    r"^\[(\d{2}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})(?:\.\d{3})?\]\s+(?:.+?\s+)?\[([A-Z ]+)\]\s?(.*)$")

# BeamMP-Server 3.x : « <nom> : Connected » puis « <nom> Connection Terminated ».
JOIN_RES = [re.compile(r"^(.+?) : Connected$"),
            re.compile(r"^Connected:\s+(.+?)\s+\(")]           # ancien format, gardé par compatibilité
LEAVE_RES = [re.compile(r"^(.+?) Connection Terminated$"),
             re.compile(r"^Disconnected:\s+(.+)$")]
ALIVE_RE = re.compile(r"ALL SYSTEMS STARTED SUCCESSFULLY", re.I)

CRITICAL_PATTERNS = [{
    "type": "auth_key_invalid",
    "re": re.compile(r"Backend REFUSED the auth key\.\s*(.*)", re.I),
    "hint": ("Clé AuthKey invalide ou expirée — le serveur est invisible dans la liste BeamMP officielle "
             "(le direct-connect reste possible). Générer une nouvelle clé sur https://keymaster.beammp.com/ "
             "puis la reporter dans Configuration."),
}]

# Une alerte non revue depuis ce délai est considérée résolue.
CRITICAL_ALERT_TTL_S = 5 * 60

_sessions: dict[str, float] = {}
_alerts: dict[str, dict[str, dict[str, Any]]] = {}
_server_started: dict[str, float] = {}


def server_started_at(instance_id: str) -> float | None:
    return _server_started.get(instance_id)


def active_alerts(instance_id: str) -> list[dict[str, Any]]:
    now_ms = time.time() * 1000
    return [a for a in _alerts.get(instance_id, {}).values()
            if now_ms - a["lastSeen"] < CRITICAL_ALERT_TTL_S * 1000]


def _record_alert(instance_id: str, type_: str, message: str, hint: str) -> None:
    per = _alerts.setdefault(instance_id, {})
    now_ms = int(time.time() * 1000)
    existing = per.get(type_)
    per[type_] = {"type": type_, "message": message, "hint": hint,
                  "firstSeen": existing["firstSeen"] if existing else now_ms, "lastSeen": now_ms}


def rank_label(count: int) -> str | None:
    # Seuils dupliqués dans frontend/src/lib/rank.ts (badge des Joueurs) :
    # les changer ici impose de les changer là-bas aussi.
    if count < 2:
        return None
    if count < 10:
        return f"🥉 Niveau Bronze {count}/10"
    if count < 100:
        return f"🥈 Niveau Argent {count}/100"
    if count < 500:
        return f"🥇 Niveau Or avec {count}/500 connexions"
    return f"💎 Niveau Platine ! {count} connexions, c'est du sérieux !"


def _parse_ts(stamp: str) -> float | None:
    try:
        ts = datetime.strptime(stamp, "%d/%m/%y %H:%M:%S").timestamp()  # heure locale, comme BeamMP
    except ValueError:
        return None
    # Une heure dans le futur = fuseau du panel différent de celui du
    # serveur (variable TZ) : mieux vaut aucune valeur qu'un uptime faux.
    return ts if ts <= time.time() + 60 else None


async def handle_join(inst: InstanceConfig, username: str) -> None:
    _sessions[f"{inst.id}:{username}"] = time.time()
    player_joined(inst.id, username)
    now = now_iso()
    db().run(
        """INSERT INTO known_players (instance_id, beammp_username, connection_count, first_seen, last_seen)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (instance_id, beammp_username) DO UPDATE
             SET connection_count = connection_count + 1, last_seen = excluded.last_seen""",
        [inst.id, username, now, now])
    row = db().one("SELECT connection_count FROM known_players WHERE instance_id = ? AND beammp_username = ?",
                   [inst.id, username])
    count = row["connection_count"] if row else 1
    label = "🥚 première connexion !" if count == 1 else (rank_label(count) or f"{count}e connexion")
    log_activity(inst.id, "player_join", f"{username} s'est connecté", username)
    await send_discord_notification("player_join", f"**{username}** — {label}")


async def handle_leave(inst: InstanceConfig, username: str) -> None:
    key = f"{inst.id}:{username}"
    start = _sessions.pop(key, None)
    player_left(inst.id, username)
    # Un « Connection Terminated » sans arrivée connue = connexion refusée
    # ou interrompue avant d'entrer (serveur plein, mauvaise version…) :
    # ce n'est pas un départ de joueur, on ne le notifie pas.
    if start is None:
        return
    seconds = int(time.time() - start)
    if seconds > 0:
        db().run("UPDATE known_players SET total_seconds = total_seconds + ? WHERE instance_id = ? AND beammp_username = ?",
                 [seconds, inst.id, username])
    mins, secs = divmod(seconds, 60)
    duration = f"{mins}m {secs}s" if mins else f"{secs}s"
    # Session très courte : souvent un souci de connexion plutôt qu'un vrai départ.
    note = " ⚠️ Ça ne fonctionne pas ? Contacte le support admin." if 0 < seconds < 120 else ""
    log_activity(inst.id, "player_leave", f"{username} s'est déconnecté · {duration} de session", username)
    await send_discord_notification("player_leave", f"**{username}** a joué pendant **{duration}**{note}")


async def process_line(inst: InstanceConfig, line: str) -> None:
    m = LINE_RE.match(line.rstrip("\r"))
    message = m.group(3) if m else line.strip()
    level = m.group(2).strip() if m else ""
    # Le chat est journalisé tel quel : un joueur qui écrit « x : Connected »
    # ne doit pas compter comme une arrivée.
    if level == "CHAT":
        return
    for rx in JOIN_RES:
        jm = rx.match(message)
        if jm:
            await handle_join(inst, jm.group(1).strip())
            return
    for rx in LEAVE_RES:
        lm = rx.match(message)
        if lm:
            await handle_leave(inst, lm.group(1).strip())
            return
    if ALIVE_RE.search(message):
        ts = _parse_ts(m.group(1)) if m else None
        _server_started[inst.id] = ts or time.time()
        mark_server_alive(inst.id)
        return
    for pat in CRITICAL_PATTERNS:
        cm = pat["re"].search(message)
        if cm:
            _record_alert(inst.id, pat["type"], cm.group(0).strip(), pat["hint"])
            return


def _scan_startup(inst: InstanceConfig) -> None:
    """Retrouve l'heure du dernier démarrage dans le journal existant (pour l'uptime)."""
    for line in reversed(tail_lines(inst.beammp.log_path, 4000)):
        if ALIVE_RE.search(line):
            m = LINE_RE.match(line)
            ts = _parse_ts(m.group(1)) if m else None
            if ts:
                _server_started[inst.id] = ts
                mark_server_alive(inst.id)
            return


async def watch_instance(inst: InstanceConfig, poll_s: float = POLL_S) -> None:
    path = inst.beammp.log_path
    offset = 0
    inode: int | None = None
    try:
        st = os.stat(path)
        offset, inode = st.st_size, st.st_ino
    except OSError:
        log.warning("Journal introuvable pour l'instance %s : %s", inst.id, path)
    _scan_startup(inst)
    pending = ""
    while True:
        try:
            st = os.stat(path)
            if inode is not None and st.st_ino != inode:
                offset, pending = 0, ""   # fichier remplacé (redémarrage de BeamMP)
            inode = st.st_ino
            if st.st_size < offset:
                offset, pending = 0, ""   # tronqué sur place
            if st.st_size > offset:
                with open(path, "rb") as f:
                    f.seek(offset)
                    chunk = f.read(st.st_size - offset)
                offset = st.st_size
                text = pending + chunk.decode("utf-8", errors="replace")
                lines = text.split("\n")
                pending = lines.pop()  # dernière ligne peut-être incomplète
                for line in lines:
                    if line:
                        try:
                            await process_line(inst, line)
                        except Exception:  # une ligne qui plante ne doit pas arrêter le suivi
                            log.exception("Ligne de journal non traitée")
        except FileNotFoundError:
            pass
        except Exception:
            log.exception("Erreur de lecture du journal %s", path)
        await asyncio.sleep(poll_s)


def start_log_watchers() -> list[asyncio.Task]:
    tasks = []
    for inst in C.config.instances:
        tasks.append(asyncio.create_task(watch_instance(inst), name=f"logwatch-{inst.id}"))
        log.info('Suivi du journal démarré pour l\'instance "%s"', inst.id)
    return tasks


def reset() -> None:
    _sessions.clear()
    _alerts.clear()
    _server_started.clear()
