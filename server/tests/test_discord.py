"""Messages Discord : contenu des embeds, webhooks par serveur, textes personnalisés."""

from __future__ import annotations

import asyncio

import pytest

from beammp_panel import config as C
from beammp_panel import discord
from beammp_panel.db import db, now_iso
from beammp_panel.security import hash_password

from .conftest import login, map_zip

HOOK = "https://discord.com/api/webhooks/1/env-general"


@pytest.fixture()
def sent(env, monkeypatch):
    """Capture les envois au lieu d'appeler Discord."""
    out: list[dict] = []

    async def fake_post(url, embed, image=None):
        out.append({"url": url, "embed": embed, "image": image})
        return "42"

    async def fake_edit(url, msg_id, embed):
        out.append({"url": url, "edit": msg_id, "embed": embed})

    monkeypatch.setattr(discord, "_post", fake_post)
    monkeypatch.setattr(discord, "_edit", fake_edit)
    C.config.discord.webhook_url = HOOK
    return out


def run(coro):
    return asyncio.run(coro)


def inst():
    return C.config.instances[0]


def test_player_join_one_line_with_server_header(client, sent):
    run(discord.notify_player_join(inst(), "Kiwi_*Drift*", "🥈 Niveau Argent 42/100", 4))
    e = sent[0]["embed"]
    assert e["author"]["name"] == inst().name and "title" not in e and e["timestamp"]
    assert e["description"] == "🟢 **Kiwi\\_\\*Drift\\*** rejoint le serveur\n-# 🥈 Niveau Argent 42/100 · 4 joueurs en ligne"


def test_player_leave_grey_and_short_session_note(client, sent):
    run(discord.notify_player_leave(inst(), "Kiwi", 47 * 60 + 12, 1))
    run(discord.notify_player_leave(inst(), "Kiwi", 30, 0))
    assert sent[0]["embed"]["color"] == discord.GREY
    assert sent[0]["embed"]["description"] == "🔴 **Kiwi** repart après **47 min 12 s**\n-# 1 joueur en ligne"
    assert "session très courte" in sent[1]["embed"]["description"]
    assert sent[1]["embed"]["description"].endswith("plus personne en ligne")


def test_custom_template_and_unknown_variable(client, sent):
    discord.save_settings(inst(), {}, {"player_join": "👋 {player} sur {server} {inconnu} {player.__class__}"})
    run(discord.notify_player_join(inst(), "Kiwi", "rang", 2))
    assert sent[0]["embed"]["description"].startswith(f"👋 Kiwi sur {inst().name} {{inconnu}} {{player.__class__}}\n")
    # Texte vidé : retour au texte par défaut.
    discord.save_settings(inst(), {}, {"player_join": ""})
    run(discord.notify_player_join(inst(), "Kiwi", "rang", 2))
    assert sent[1]["embed"]["description"].startswith("🟢 **Kiwi** rejoint")


def test_webhook_priority(client, sent):
    d = C.config.discord
    d.webhook_players = "https://discord.com/api/webhooks/2/env-players"
    assert discord._webhook_url("player_join", inst()) == d.webhook_players
    assert discord._webhook_url("mod_upload", inst()) == HOOK
    discord.save_settings(inst(), {"url": "https://discord.com/api/webhooks/3/db-general"}, {})
    assert discord._webhook_url("player_join", inst()).endswith("/3/db-general")
    discord.save_settings(inst(), {"url": "https://discord.com/api/webhooks/3/db-general",
                                   "players": "https://discord.com/api/webhooks/4/db-players"}, {})
    assert discord._webhook_url("player_join", inst()).endswith("/4/db-players")
    assert discord._webhook_url("server_crash", inst()).endswith("/3/db-general")


def test_invalid_webhook_rejected(client, sent):
    with pytest.raises(ValueError):
        discord.save_settings(inst(), {"players": "http://169.254.169.254/latest"}, {})
    with pytest.raises(ValueError):
        discord.save_settings(inst(), {}, {"player_join": "x" * 301})


def test_disabled_event_not_sent(client, sent):
    C.config.discord.notify_join = False
    run(discord.notify_player_join(inst(), "Kiwi", "rang", 1))
    assert sent == []


def test_crash_message_turns_green(client, sent):
    notice = discord.CrashNotice(inst())
    run(notice.crashed(139))
    assert sent[0]["embed"]["title"] == "💥 Plantage, relance automatique"
    assert "code de sortie 139" in sent[0]["embed"]["description"]
    run(notice.recovered(notice.at + 7, 2, 10))
    edit = sent[1]
    assert edit["edit"] == "42" and edit["embed"]["color"] == discord.GREEN_OK
    assert edit["embed"]["title"] == "✅ Relancé après plantage"
    assert "en **7 s**" in edit["embed"]["description"] and "2ᵉ plantage en 10 min" in edit["embed"]["description"]


def test_crash_loop_and_update(client, sent):
    run(discord.notify_crash_loop(inst(), 6, 10, 1))
    assert sent[0]["embed"]["title"] == "🛑 Relance automatique suspendue"
    assert sent[0]["embed"]["description"].startswith("6 plantages en 10 min (code 1)")
    run(discord.notify_update(inst(), "3.8.2", "3.9.0"))
    assert sent[1]["embed"]["description"].startswith("⬆️ BeamMP-Server ~~v3.8.2~~ → **v3.9.0**")


def test_map_change_strikes_old_map_and_attaches_preview(admin, sent):
    from .test_api import upload
    upload(admin, map_zip("italy"), "italy.zip", "Italy", "map", map_id="/levels/italy/info.json")
    upload(admin, map_zip("utah"), "utah.zip", "Utah", "map", map_id="/levels/utah/info.json")
    sent.clear()
    assert admin.post("/api/i/default/maps/activate", json={"map_id": "/levels/utah/info.json"}).status_code == 200
    e = sent[-1]["embed"]
    assert e["description"].startswith("🗺️ Prochaine carte : **Utah**\n~~Italy~~ → **Utah**\n")
    assert sent[-1]["image"] and sent[-1]["image"].startswith(C.config.images_path)


def test_mod_upload_message(admin, sent):
    from .conftest import vehicle_zip
    from .test_api import upload
    assert upload(admin, vehicle_zip(), "dynamo.zip", "Dynamo", "vehicle").status_code == 200
    assert sent[-1]["embed"]["description"].startswith("📦 **Dynamo** ajouté · véhicule · ")


def test_discord_routes_superadmin_only(client, sent):
    db().run("INSERT INTO users (username, password, role, created_at) VALUES ('adm', ?, 'admin', ?)",
             [hash_password("motdepasse-adm"), now_iso()])
    login(client, "adm", "motdepasse-adm")
    assert client.get("/api/i/default/discord").status_code == 403
    client.post("/api/auth/logout")
    login(client)
    r = client.get("/api/i/default/discord").json()
    assert r["envFallback"]["url"] is True and HOOK not in str(r)
    assert set(r["templates"]) == set(discord.EVENTS)
    bad = client.put("/api/i/default/discord", json={"webhooks": {"mods": "https://evil.example/x"}, "templates": {}})
    assert bad.status_code == 400
    ok = client.put("/api/i/default/discord", json={"webhooks": {"mods": "https://discord.com/api/webhooks/9/x"},
                                                    "templates": {"map_change": "🗺️ {map}"}}).json()
    assert ok["webhooks"]["mods"].endswith("/9/x") and ok["templates"]["map_change"] == "🗺️ {map}"
    assert client.post("/api/i/default/discord/test", json={"url": "https://evil.example/x"}).json() == \
        {"ok": False, "error": "Adresse de webhook invalide"}
