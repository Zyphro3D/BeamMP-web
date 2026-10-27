"""Petits utilitaires HTTP partagés par les routes."""

from __future__ import annotations

import json
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse

from . import config as C
from .config import InstanceConfig
from .security import ApiError


def ok(data: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status)


MAX_JSON_BYTES = 1024 * 1024


async def json_body(request: Request) -> dict[str, Any]:
    """Lit un corps JSON borné. Le type application/json est exigé : un
    formulaire ou un text/plain d'un autre site ne passe pas sans requête
    préalable CORS, que le panel n'accorde pas."""
    declared = request.headers.get("content-length")
    if declared and (not declared.isdigit() or int(declared) > MAX_JSON_BYTES):
        raise ApiError(413, "Corps de requête trop volumineux")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_JSON_BYTES:
            raise ApiError(413, "Corps de requête trop volumineux")
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw:
        return {}
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if ctype != "application/json":
        raise ApiError(415, "Content-Type application/json attendu")
    try:
        data = json.loads(raw)
    except ValueError:
        raise ApiError(400, "Corps JSON invalide")
    if not isinstance(data, dict):
        raise ApiError(400, "Un objet JSON est attendu")
    return data


def instance_or_404(instance_id: str) -> InstanceConfig:
    inst = C.get_instance(instance_id)
    if not inst:
        raise ApiError(404, f"Instance '{instance_id}' not found")
    return inst


def int_param(request: Request, name: str) -> int:
    raw = request.path_params.get(name, "")
    if not str(raw).isdigit():
        raise ApiError(400, f"{name} doit être un entier")
    return int(raw)


def require_str(body: dict[str, Any], key: str, min_len: int = 1, max_len: int = 200) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not (min_len <= len(value) <= max_len):
        raise ApiError(400, f"body/{key} invalide ({min_len} à {max_len} caractères)")
    return value
