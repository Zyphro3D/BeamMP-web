"""Mots de passe, jetons, rôles, limitation de débit.

Compatible avec la v2 : mêmes hachages bcrypt (coût 12), même migration
transparente des anciens hachages scrypt, même jeton JWT HS256 dans le
cookie `beammp_token`. Avec le même JWT_SECRET, une session ouverte sur la
v2 reste valide après la bascule.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import threading
import time
from collections import defaultdict, deque
from typing import Any

import bcrypt
import jwt
from starlette.requests import Request

from . import config as C
from .db import db

BCRYPT_ROUNDS = 12
LEGACY_SALT = b"beammp-salt"  # seulement pour la migration unique des anciens comptes
TOKEN_TTL_S = 7 * 24 * 60 * 60
COOKIE_NAME = "beammp_token"

# Hachage factice : comparé quand l'utilisateur n'existe pas, pour que la
# durée de réponse ne trahisse pas quels comptes existent.
_DUMMY_HASH = bcrypt.hashpw(b"dummy-password", bcrypt.gensalt(BCRYPT_ROUNDS))


class ApiError(Exception):
    """Erreur renvoyée au client en JSON `{error}` avec ce code HTTP."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ── Mots de passe ──────────────────────────────────────────────

def _pw_bytes(password: str) -> bytes:
    """bcrypt ne lit que 72 octets : les versions 4 tronquaient en silence,
    la 5 lève ValueError. On tronque partout pareil, pour garder les
    hachages déjà créés et répondre de la même façon que le compte existe ou non."""
    return password.encode("utf-8")[:72]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_pw_bytes(password), bcrypt.gensalt(BCRYPT_ROUNDS)).decode("ascii")


def verify_password(password: str, stored: str) -> tuple[bool, bool]:
    """Renvoie (ok, à_rehacher)."""
    if stored.startswith(("$2b$", "$2a$", "$2y$")):
        try:
            return bcrypt.checkpw(_pw_bytes(password), stored.encode("ascii")), False
        except ValueError:
            return False, False
    # Ancien scrypt à sel fixe (paramètres par défaut de Node : N=16384, r=8, p=1).
    legacy = hashlib.scrypt(password.encode("utf-8"), salt=LEGACY_SALT, n=16384, r=8, p=1, dklen=64).hex()
    try:
        ok = hmac.compare_digest(legacy, stored)
    except TypeError:  # valeur stockée non ASCII
        return False, False
    return ok, ok


def dummy_verify(password: str) -> None:
    bcrypt.checkpw(_pw_bytes(password), _DUMMY_HASH)


def sign_token(user: dict[str, Any]) -> str:
    now = int(time.time())
    payload = {"id": user["id"], "username": user["username"], "role": user["role"],
               "tv": int(user.get("token_version") or 0), "iat": now, "exp": now + TOKEN_TTL_S}
    return jwt.encode(payload, C.config.jwt_secret, algorithm="HS256")


def revoke_tokens(user_id: int) -> None:
    """Invalide tous les jetons déjà émis pour ce compte (déconnexion,
    changement ou réinitialisation du mot de passe, changement de rôle)."""
    db().run("UPDATE users SET token_version = token_version + 1 WHERE id = ?", [user_id])


def _token_from_request(request: Request) -> str | None:
    token = request.cookies.get(COOKIE_NAME)
    if token:
        return token
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def authenticate(request: Request) -> dict[str, Any]:
    """Vérifie le jeton puis relit l'utilisateur en base.

    Le jeton seul prouve « je suis l'utilisateur N » pendant 7 jours ; relire
    la base à chaque requête fait qu'un changement de rôle ou une suppression
    de compte s'applique tout de suite, pas à l'expiration du cookie. La
    version de jeton (`tv`) révoque les sessions déjà ouvertes : un jeton
    sans `tv` (v2, ou 3.2.0) vaut la version 0.
    """
    token = _token_from_request(request)
    if not token:
        raise ApiError(401, "Unauthorized")
    try:
        payload = jwt.decode(token, C.config.jwt_secret, algorithms=["HS256"], options={"require": ["exp"]})
    except jwt.PyJWTError:
        raise ApiError(401, "Unauthorized")
    user = db().one("SELECT id, username, role, token_version FROM users WHERE id = ?", [payload.get("id")])
    if not user or payload.get("tv", 0) != user["token_version"]:
        raise ApiError(401, "Unauthorized")
    return user


def require_auth(request: Request) -> dict[str, Any]:
    return authenticate(request)


def require_admin(request: Request) -> dict[str, Any]:
    """superadmin/admin seulement : moderator reste en lecture seule."""
    user = authenticate(request)
    if user["role"] not in ("superadmin", "admin"):
        raise ApiError(403, "Forbidden")
    return user


def require_superadmin(request: Request) -> dict[str, Any]:
    user = authenticate(request)
    if user["role"] != "superadmin":
        raise ApiError(403, "Forbidden")
    return user


# ── Adresse du client ──────────────────────────────────────────

def _trusted(peer: str) -> bool:
    spec = C.config.trust_proxy
    if not spec:
        return False
    if spec == "true":
        return True
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return False
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            if addr in ipaddress.ip_network(part, strict=False):
                return True
        except ValueError:
            continue
    return False


def client_ip(request: Request) -> str:
    """IP réelle du client.

    X-Forwarded-For n'est pris en compte que si le pair direct est un proxy
    déclaré dans TRUST_PROXY : sinon n'importe qui pourrait le forger pour
    obtenir un nouveau quota à chaque tentative de connexion.
    """
    peer = request.client.host if request.client else ""
    if not _trusted(peer):
        return peer
    hops = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
    # Le premier saut non approuvé en partant de la fin est le vrai client.
    for hop in reversed(hops):
        if not _trusted(hop):
            return hop
    return hops[0] if hops else peer


# ── Limitation de débit ────────────────────────────────────────

class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, request: Request, bucket: str, max_hits: int, window_s: float) -> None:
        self._hit((bucket, client_ip(request)), max_hits, window_s)

    def check_key(self, key: str, max_hits: int, window_s: float) -> None:
        """Même limite, sur une clé choisie (par exemple un compte) plutôt que l'IP."""
        self._hit((key, ""), max_hits, window_s)

    def _hit(self, key: tuple[str, str], max_hits: int, window_s: float) -> None:
        now = time.monotonic()
        with self._lock:
            if len(self._hits) > 10_000:  # purge des clés vides (IP de passage)
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] > 3600]:
                    del self._hits[k]
            hits = self._hits[key]
            while hits and now - hits[0] > window_s:
                hits.popleft()
            if len(hits) >= max_hits:
                retry = int(window_s - (now - hits[0])) + 1
                raise ApiError(429, f"Trop de requêtes, réessayez dans {retry} s")
            hits.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = RateLimiter()
