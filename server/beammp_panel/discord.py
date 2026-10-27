"""Notifications Discord par webhook."""

from __future__ import annotations

import logging
import re

import httpx

from . import config as C
from .db import now_iso

log = logging.getLogger("beammp_panel.discord")

COLORS = {
    "player_join": 0x57F287,
    "player_leave": 0xED4245,
    "mod_upload": 0x5865F2,
    "map_change": 0x5865F2,
    "server_restart": 0xFEE75C,
    "server_update": 0xFEE75C,
    "preset_applied": 0x5865F2,
}

TITLES = {
    "player_join": "🟢 Joueur connecté",
    "player_leave": "🔴 Joueur déconnecté",
    "mod_upload": "📦 Nouveau mod uploadé",
    "map_change": "🗺️ Carte changée",
    "server_restart": "🔄 Serveur redémarré",
    "server_update": "⬆️ Serveur mis à jour",
    "preset_applied": "🎛️ Config appliquée",
}


def _webhook_url(event: str) -> str:
    # Priorité : webhook spécifique, sinon webhook global.
    d = C.config.discord
    if event in ("server_restart", "server_update"):
        return d.webhook_restart or d.webhook_url
    if event in ("player_join", "player_leave"):
        return d.webhook_players or d.webhook_url
    if event in ("mod_upload", "map_change", "preset_applied"):
        return d.webhook_mods or d.webhook_url
    return d.webhook_url


def _enabled(event: str) -> bool:
    d = C.config.discord
    return {
        "player_join": d.notify_join,
        "player_leave": d.notify_leave,
        "mod_upload": d.notify_mod_upload,
        "map_change": d.notify_map_change,
        "preset_applied": d.notify_map_change,
        "server_restart": d.notify_restart,
        "server_update": d.notify_restart,
    }.get(event, True)


def md_escape(text: str) -> str:
    """Neutralise la mise en forme Markdown de Discord dans un texte de joueur."""
    return re.sub(r"([\\*_~`|>\[\]()@#])", r"\\\1", text)


async def send_discord_notification(event: str, description: str) -> None:
    url = _webhook_url(event)
    if not url or not _enabled(event):
        return
    payload = {
        "username": "BeamMP Panel",
        # Aucune mention ne notifie personne, même si un nom de joueur en contient.
        "allowed_mentions": {"parse": []},
        "embeds": [{
            "title": TITLES.get(event, event),
            "description": description[:4096],
            "color": COLORS.get(event, 0x5865F2),
            "timestamp": now_iso(),
        }],
    }
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(url, json=payload)
    except httpx.HTTPError as err:
        log.error("Webhook Discord en échec : %s", err)
