"""Connexion, déconnexion, demande de compte, changement de mot de passe."""

from __future__ import annotations

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.routing import Route

from . import config as C
from .db import db, now_iso
from .security import (COOKIE_NAME, TOKEN_TTL_S, ApiError, dummy_verify, hash_password, limiter,
                       revoke_tokens, require_auth, sign_token, verify_password)
from .security import authenticate
from .web import json_body, ok, require_str


async def login(request: Request):
    limiter.check(request, "login", 5, 60)
    body = await json_body(request)
    username = require_str(body, "username", 1, 100)
    password = require_str(body, "password", 1, 200)

    user = db().one("SELECT id, username, password, role, token_version FROM users WHERE username = ?", [username])
    if not user:
        await run_in_threadpool(dummy_verify, password)  # même durée qu'un vrai essai : n'indique pas si le compte existe
        raise ApiError(401, "Identifiants invalides")
    good, needs_rehash = await run_in_threadpool(verify_password, password, user["password"])
    if not good:
        raise ApiError(401, "Identifiants invalides")
    if needs_rehash:  # ancien scrypt → bcrypt, de façon transparente
        db().run("UPDATE users SET password = ? WHERE id = ?", [await run_in_threadpool(hash_password, password), user["id"]])

    public = {"id": user["id"], "username": user["username"], "role": user["role"]}
    response = ok({"user": public})
    _set_session(response, user)
    return response


def _set_session(response, user: dict) -> None:
    response.set_cookie(COOKIE_NAME, sign_token(user), max_age=TOKEN_TTL_S, path="/",
                        httponly=True, samesite="strict", secure=C.config.cookie_secure)


async def logout(request: Request):
    # Révoque aussi le jeton côté serveur : une copie du cookie ne sert plus.
    try:
        revoke_tokens(authenticate(request)["id"])
    except ApiError:
        pass
    response = ok({"ok": True})
    response.delete_cookie(COOKIE_NAME, path="/")
    return response


async def request_account(request: Request):
    limiter.check(request, "request-account", 5, 60)
    body = await json_body(request)
    username = require_str(body, "beammp_username", 1, 100)
    if not db().one("SELECT id FROM known_players WHERE beammp_username = ?", [username]):
        raise ApiError(400, "Ce nom de joueur est inconnu. Connectez-vous au serveur BeamMP d'abord.")
    if db().one("SELECT id FROM account_requests WHERE beammp_username = ? AND status IN ('pending', 'approved')",
                [username]):
        raise ApiError(409, "Une demande existe déjà pour ce joueur.")
    db().run("INSERT INTO account_requests (beammp_username, requested_at) VALUES (?, ?)", [username, now_iso()])
    return ok({"message": "Demande envoyée. En attente de validation par un SuperAdmin."})


async def change_password(request: Request):
    user = require_auth(request)
    limiter.check(request, "password", 5, 60)
    limiter.check_key(f"password-user:{user['id']}", 5, 60)
    body = await json_body(request)
    current = require_str(body, "currentPassword", 1, 200)
    new = require_str(body, "newPassword", 8, 200)
    row = db().one("SELECT password FROM users WHERE id = ?", [user["id"]])
    if not row:
        raise ApiError(404, "Not found")
    good, _ = await run_in_threadpool(verify_password, current, row["password"])
    if not good:
        raise ApiError(401, "Mot de passe actuel incorrect")
    db().run("UPDATE users SET password = ? WHERE id = ?", [await run_in_threadpool(hash_password, new), user["id"]])
    # Les autres sessions de ce compte tombent ; celle-ci reçoit un jeton neuf.
    revoke_tokens(user["id"])
    response = ok({"ok": True})
    _set_session(response, db().one("SELECT id, username, role, token_version FROM users WHERE id = ?", [user["id"]]))
    return response


routes = [
    Route("/api/auth/login", login, methods=["POST"]),
    Route("/api/auth/logout", logout, methods=["POST"]),
    Route("/api/auth/request-account", request_account, methods=["POST"]),
    Route("/api/auth/password", change_password, methods=["PATCH"]),
]
