"""Réglages Discord d'une instance : webhooks par salon, textes des messages, essai.

Réservé au superadmin : une adresse de webhook permet d'écrire dans le salon.
"""

from __future__ import annotations

from starlette.requests import Request
from starlette.routing import Route

from . import discord
from .security import ApiError, limiter, require_superadmin
from .web import instance_or_404, json_body, ok


async def get_discord(request: Request):
    require_superadmin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    return ok(discord.get_settings(inst))


async def put_discord(request: Request):
    require_superadmin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    body = await json_body(request)
    webhooks, templates = body.get("webhooks") or {}, body.get("templates") or {}
    if not isinstance(webhooks, dict) or not isinstance(templates, dict):
        raise ApiError(400, "webhooks et templates doivent être des objets")
    try:
        discord.save_settings(inst, webhooks, templates)
    except ValueError as err:
        raise ApiError(400, str(err))
    return ok(discord.get_settings(inst))


async def test_discord(request: Request):
    require_superadmin(request)
    inst = instance_or_404(request.path_params["instanceId"])
    limiter.check(request, f"discord-test:{inst.id}", 5, 60)
    body = await json_body(request)
    url = str(body.get("url") or "").strip()
    if not url:
        raise ApiError(400, "url is required")
    good, error = await discord.test_webhook(url)
    return ok({"ok": good, "error": error})


routes = [
    Route("/api/i/{instanceId}/discord", get_discord, methods=["GET"]),
    Route("/api/i/{instanceId}/discord", put_discord, methods=["PUT"]),
    Route("/api/i/{instanceId}/discord/test", test_discord, methods=["POST"]),
]
