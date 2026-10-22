"""Fil d'activité récent par instance (en mémoire, 50 derniers événements)."""

from __future__ import annotations

import itertools
import threading
from collections import defaultdict, deque
from typing import Any

from .db import now_iso

MAX = 50
_counter = itertools.count(1)
_store: dict[str, deque[dict[str, Any]]] = defaultdict(lambda: deque(maxlen=MAX))
_lock = threading.Lock()


def log_activity(instance_id: str, type_: str, message: str, user: str | None = None) -> None:
    event: dict[str, Any] = {"id": next(_counter), "type": type_, "message": message, "timestamp": now_iso()}
    if user is not None:
        event["user"] = user
    with _lock:
        _store[instance_id].appendleft(event)


def get_activity(instance_id: str, limit: int = 20) -> list[dict[str, Any]]:
    with _lock:
        return list(_store[instance_id])[:limit]


def reset() -> None:
    with _lock:
        _store.clear()
