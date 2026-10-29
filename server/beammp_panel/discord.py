"""Notifications Discord par webhook.

Le serveur concerné passe en en-tête de chaque message (champ « author ») et
l'heure est l'horodatage natif de Discord, affiché dans le fuseau de chaque
lecteur. Webhooks par serveur et textes personnalisés sont dans la table
discord_settings ; le .env reste le repli.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import time
from typing import Any

import httpx

from . import config as C
from .config import InstanceConfig
from .db import db, now_iso
from .files import resolve_within

log = logging.getLogger("beammp_panel.discord")

WEBHOOK_PREFIXES = ("https://discord.com/api/webhooks/", "https://discordapp.com/api/webhooks/",
                    "https://ptb.discord.com/api/webhooks/", "https://canary.discord.com/api/webhooks/")

GREEN, GREEN_OK, RED, GREY, YELLOW, BLURPLE = 0x57F287, 0x2ECC71, 0xE74C3C, 0x80848E, 0xFEE75C, 0x5865F2

# Salon : « restart » (état du serveur), « players », « mods » (mods et cartes).
CHANNELS = ("restart", "players", "mods")

# événement → (salon, texte par défaut, variables, en titre plutôt qu'en première ligne)
EVENTS: dict[str, tuple[str, str, tuple[str, ...], bool]] = {
    "server_restart": ("restart", "🔄 Redémarré par un admin", ("server", "admin"), False),
    "server_update": ("restart", "⬆️ BeamMP-Server ~~{old}~~ → **{new}**", ("server", "old", "new"), False),
    "server_crash": ("restart", "💥 Plantage, relance automatique", ("server", "code"), True),
    "server_crash_recovered": ("restart", "✅ Relancé après plantage", ("server",), True),
    "server_crash_loop": ("restart", "🛑 Relance automatique suspendue", ("server", "count", "minutes"), True),
    "player_join": ("players", "🟢 **{player}** rejoint le serveur", ("server", "player", "rank", "online"), False),
    "player_leave": ("players", "🔴 **{player}** repart après **{duration}**", ("server", "player", "duration", "online"), False),
    "mod_upload": ("mods", "📦 **{name}** ajouté · {type} · {size}", ("server", "name", "type", "size"), False),
    "map_change": ("mods", "🗺️ Prochaine carte : **{map}**", ("server", "map", "old_map"), False),
    "preset_applied": ("mods", "🎛️ Config **{preset}** appliquée", ("server", "preset", "map", "mods"), False),
}

MAX_TEMPLATE_LEN = 300
GLOBAL = "*"   # instance_id des réglages communs à tous les serveurs (textes)


# ── Réglages ──────────────────────────────────────────────────

def _settings(instance_id: str) -> dict[str, str]:
    try:
        rows = db().all("SELECT key, value FROM discord_settings WHERE instance_id = ?", [instance_id])
    except Exception:  # base indisponible : on retombe sur le .env
        return {}
    return {r["key"]: r["value"] for r in rows}


def get_settings(inst: InstanceConfig) -> dict[str, Any]:
    own, shared = _settings(inst.id), _settings(GLOBAL)
    d = C.config.discord
    env_hooks = {"url": d.webhook_url, "restart": d.webhook_restart, "players": d.webhook_players, "mods": d.webhook_mods}
    return {
        "webhooks": {k: own.get(f"webhook_{k}", "") for k in ("url", *CHANNELS)},
        # Le .env n'est jamais renvoyé : on dit seulement s'il fournit un repli.
        "envFallback": {k: bool(v) for k, v in env_hooks.items()},
        "templates": {e: shared.get(f"msg_{e}", "") for e in EVENTS},
        "defaults": {e: {"text": t, "vars": list(v), "channel": ch} for e, (ch, t, v, _) in EVENTS.items()},
    }


def valid_webhook(url: str) -> bool:
    return url.startswith(WEBHOOK_PREFIXES) and len(url) < 300 and not re.search(r"[\s?#]", url)


def save_settings(inst: InstanceConfig, webhooks: dict[str, Any], templates: dict[str, Any]) -> None:
    rows: list[tuple[str, str, str]] = []
    for key in ("url", *CHANNELS):
        value = str(webhooks.get(key) or "").strip()
        if value and not valid_webhook(value):
            raise ValueError(f"Adresse de webhook invalide ({key}) : elle doit commencer par https://discord.com/api/webhooks/")
        rows.append((inst.id, f"webhook_{key}", value))
    for event in EVENTS:
        value = str(templates.get(event) or "").strip()
        if len(value) > MAX_TEMPLATE_LEN:
            raise ValueError(f"Texte trop long ({event}) : {MAX_TEMPLATE_LEN} caractères au plus")
        rows.append((GLOBAL, f"msg_{event}", value))
    with db().transaction() as t:
        for iid, key, value in rows:
            if value:
                t.run("INSERT INTO discord_settings (instance_id, key, value) VALUES (?, ?, ?) "
                      "ON CONFLICT (instance_id, key) DO UPDATE SET value = excluded.value", [iid, key, value])
            else:
                t.run("DELETE FROM discord_settings WHERE instance_id = ? AND key = ?", [iid, key])


def _webhook_url(event: str, inst: InstanceConfig) -> str:
    # Priorité : webhook du salon pour ce serveur, webhook général de ce serveur,
    # puis les mêmes dans le .env.
    channel = EVENTS[event][0]
    own = _settings(inst.id)
    d = C.config.discord
    env_channel = {"restart": d.webhook_restart, "players": d.webhook_players, "mods": d.webhook_mods}[channel]
    return own.get(f"webhook_{channel}") or own.get("webhook_url") or env_channel or d.webhook_url


def _enabled(event: str) -> bool:
    d = C.config.discord
    return {
        "player_join": d.notify_join,
        "player_leave": d.notify_leave,
        "mod_upload": d.notify_mod_upload,
        "map_change": d.notify_map_change,
        "preset_applied": d.notify_map_change,
    }.get(event, d.notify_restart)


# ── Mise en forme ─────────────────────────────────────────────

def md_escape(text: str) -> str:
    """Neutralise la mise en forme Markdown de Discord dans un texte de joueur."""
    return re.sub(r"([\\*_~`|>\[\]()@#])", r"\\\1", text)


def _render(event: str, values: dict[str, str]) -> str:
    """Texte personnalisé (ou par défaut) avec ses variables. Simple remplacement de
    {nom} : pas de str.format, qui laisserait un texte d'admin lire des attributs."""
    custom = _settings(GLOBAL).get(f"msg_{event}", "")
    text = custom or EVENTS[event][1]
    return re.sub(r"\{(\w+)\}", lambda m: values.get(m.group(1), m.group(0)), text)


def fmt_duration(seconds: int) -> str:
    seconds = max(0, int(seconds))
    h, rest = divmod(seconds, 3600)
    m, s = divmod(rest, 60)
    if h:
        return f"{h} h {m:02d} min"
    return f"{m} min {s} s" if m else f"{s} s"


def fmt_size(n: int) -> str:
    return f"{n / 1_048_576:.0f} Mo" if n >= 1_048_576 else f"{max(1, n // 1024)} Ko"


def players_online(n: int) -> str:
    if n <= 0:
        return "plus personne en ligne"
    return "1 joueur en ligne" if n == 1 else f"{n} joueurs en ligne"


def were_connected(n: int) -> str:
    if n <= 0:
        return "aucun joueur connecté"
    return "1 joueur était connecté" if n == 1 else f"{n} joueurs étaient connectés"


def _context(inst: InstanceConfig) -> tuple[int, str]:
    """Joueurs connectés et carte active, pour situer un événement serveur."""
    from .status import _active_map, online_players  # import tardif : status importe beaucoup
    current = _active_map(inst.id)
    return len(online_players(inst.id)), str(current["name"]) if current else ""


# ── Envoi ─────────────────────────────────────────────────────

def _embed(inst: InstanceConfig, event: str, values: dict[str, str], lines: list[str], color: int) -> dict[str, Any]:
    values = {"server": md_escape(inst.name), **values}
    head = _render(event, values)
    embed: dict[str, Any] = {"author": {"name": inst.name[:256]}, "color": color, "timestamp": now_iso()}
    body = [line for line in lines if line]
    if EVENTS[event][3]:
        embed["title"] = head[:256]
    else:
        body.insert(0, head)
    if body:
        embed["description"] = "\n".join(body)[:4096]
    return embed


async def _post(url: str, embed: dict[str, Any], image: str | None = None) -> str | None:
    """Publie l'embed ; renvoie l'identifiant du message (pour le modifier ensuite)."""
    payload: dict[str, Any] = {
        "username": "BeamMP Panel",
        # Aucune mention ne notifie personne, même si un nom de joueur en contient.
        "allowed_mentions": {"parse": []},
        "embeds": [embed],
    }
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            if image:
                # Vignette envoyée en pièce jointe : le panel n'a pas besoin d'adresse publique.
                ext = os.path.splitext(image)[1].lower() or ".png"
                name = f"apercu{ext}"
                embed["thumbnail"] = {"url": f"attachment://{name}"}
                payload["attachments"] = [{"id": 0, "filename": name}]
                with open(image, "rb") as fh:
                    data = fh.read()
                res = await client.post(url, params={"wait": "true"}, data={"payload_json": json.dumps(payload)},
                                        files={"files[0]": (name, data, mimetypes.guess_type(name)[0] or "image/png")})
            else:
                res = await client.post(url, params={"wait": "true"}, json=payload)
        if res.status_code >= 300:
            log.error("Webhook Discord : HTTP %s %s", res.status_code, res.text[:200])
            return None
        msg_id = str(res.json().get("id", ""))
        return msg_id if msg_id.isdigit() else None
    except (httpx.HTTPError, OSError, ValueError) as err:
        log.error("Webhook Discord en échec : %s", err)
        return None


async def _edit(url: str, msg_id: str, embed: dict[str, Any]) -> None:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.patch(f"{url}/messages/{msg_id}", json={"embeds": [embed]})
    except httpx.HTTPError as err:
        log.error("Webhook Discord (modification) en échec : %s", err)


async def _send(event: str, inst: InstanceConfig, values: dict[str, str], lines: list[str], color: int,
                image: str | None = None) -> tuple[str, str] | None:
    """Envoie si l'événement est actif et qu'un webhook est défini ; renvoie (webhook, message)."""
    url = _webhook_url(event, inst)
    if not url or not _enabled(event) or not valid_webhook(url):
        return None
    msg_id = await _post(url, _embed(inst, event, values, lines, color), image)
    return (url, msg_id) if msg_id else None


async def test_webhook(url: str) -> tuple[bool, str]:
    if not valid_webhook(url):
        return False, "Adresse de webhook invalide"
    embed = {"author": {"name": "BeamMP Panel"}, "color": GREEN_OK, "timestamp": now_iso(),
             "description": "✅ Message d'essai : ce salon recevra les notifications du panel."}
    payload = {"username": "BeamMP Panel", "allowed_mentions": {"parse": []}, "embeds": [embed]}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.post(url, json=payload)
    except httpx.HTTPError as err:
        return False, f"Discord injoignable : {err}"
    if res.status_code >= 300:
        return False, "Webhook refusé par Discord (supprimé ou mal copié ?)" if res.status_code in (401, 404) \
            else f"Discord a répondu HTTP {res.status_code}"
    return True, ""


# ── Événements ────────────────────────────────────────────────

async def notify_player_join(inst: InstanceConfig, username: str, rank: str, online: int) -> None:
    values = {"player": md_escape(username), "rank": rank, "online": str(online)}
    await _send("player_join", inst, values, [f"-# {rank} · {players_online(online)}"], GREEN)


async def notify_player_leave(inst: InstanceConfig, username: str, seconds: int, online: int) -> None:
    duration = fmt_duration(seconds)
    values = {"player": md_escape(username), "duration": duration, "online": str(online)}
    lines = []
    # Session très courte : souvent un souci de connexion plutôt qu'un vrai départ.
    if 0 < seconds < 120:
        lines.append("-# session très courte : un souci pour te connecter ? Demande au support admin")
    lines.append(f"-# {players_online(online)}")
    await _send("player_leave", inst, values, lines, GREY)


async def notify_restart(inst: InstanceConfig, admin: str) -> None:
    online, current_map = _context(inst)
    sub = " · ".join(x for x in (were_connected(online), md_escape(current_map)) if x)
    await _send("server_restart", inst, {"admin": md_escape(admin)}, [f"-# {sub}"], YELLOW)


def _version(v: str | None) -> str:
    v = (v or "").strip()
    return "" if not v else (v if v.startswith("v") else f"v{v}")


async def notify_update(inst: InstanceConfig, old: str | None, new: str) -> None:
    values = {"old": _version(old) or "version inconnue", "new": _version(new)}
    await _send("server_update", inst, values, ["-# pensez à mettre à jour le launcher si le jeu le demande"], YELLOW)


class CrashNotice:
    """Message de plantage, modifié en place quand le serveur repart."""

    def __init__(self, inst: InstanceConfig):
        self.inst = inst
        self.sent: tuple[str, str] | None = None
        self.at = 0.0
        self.map = ""

    async def crashed(self, code: int | None) -> None:
        self.at = time.time()
        online, current_map = _context(self.inst)
        self.map = md_escape(current_map)
        first = " · ".join(x for x in (self.map, f"code de sortie {code}" if code is not None else "") if x)
        lines = [first, f"-# {were_connected(online)}"]
        self.sent = await _send("server_crash", self.inst, {"code": str(code)}, lines, RED)

    async def recovered(self, back_at: float, crashes_in_window: int, window_min: int) -> None:
        if not self.sent:
            return
        url, msg_id = self.sent
        delay = max(1, round(back_at - self.at))
        nth = "1er plantage" if crashes_in_window <= 1 else f"{crashes_in_window}ᵉ plantage"
        lines = [" · ".join(x for x in (self.map, f"de nouveau en ligne en **{delay} s**") if x),
                 f"-# {nth} en {window_min} min"]
        await _edit(url, msg_id, _embed(self.inst, "server_crash_recovered", {}, lines, GREEN_OK))
        self.sent = None


async def notify_crash_loop(inst: InstanceConfig, count: int, minutes: int, code: int | None) -> None:
    values = {"count": str(count), "minutes": str(minutes)}
    lines = [f"{count} plantages en {minutes} min" + (f" (code {code})" if code is not None else ""),
             "-# à relancer depuis le panel, onglet Configuration"]
    await _send("server_crash_loop", inst, values, lines, RED)


MOD_TYPES = {"mod": "mod", "vehicle": "véhicule", "map": "carte"}


async def notify_mod_upload(inst: InstanceConfig, name: str, type_: str, size: int, active: bool) -> None:
    values = {"name": md_escape(name), "type": MOD_TYPES.get(type_, type_), "size": fmt_size(size)}
    sub = "-# actif dès le prochain redémarrage" if active else "-# désactivé pour l'instant"
    await _send("mod_upload", inst, values, [sub], BLURPLE)


def _image_path(image: str | None) -> str | None:
    if not image:
        return None
    path = resolve_within(C.config.images_path, image)
    return path if path and os.path.isfile(path) and os.path.getsize(path) < 8_000_000 else None


async def notify_map_change(inst: InstanceConfig, new_map: dict[str, Any], old_name: str | None) -> None:
    name = str(new_map.get("name") or new_map.get("map_id") or "?")
    values = {"map": md_escape(name), "old_map": md_escape(old_name or "")}
    lines = []
    if old_name and old_name != name:
        lines.append(f"~~{md_escape(old_name)}~~ → **{md_escape(name)}**")
    lines.append("-# appliquée au prochain redémarrage du serveur")
    await _send("map_change", inst, values, lines, BLURPLE, image=_image_path(new_map.get("image")))


async def notify_preset(inst: InstanceConfig, preset: str, map_name: str | None, mods: int, restarted: bool) -> None:
    values = {"preset": md_escape(preset), "map": md_escape(map_name or ""), "mods": str(mods)}
    detail = " · ".join(x for x in (md_escape(map_name) if map_name else "", f"{mods} mod{'s' if mods > 1 else ''} actif{'s' if mods > 1 else ''}") if x)
    sub = "-# serveur redémarré" if restarted else "-# appliquée au prochain redémarrage du serveur"
    await _send("preset_applied", inst, values, [detail, sub], BLURPLE)
