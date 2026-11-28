"""#4744 (version dans /api/info) et #4746 (activité composée dans la langue de l'utilisateur)."""
from __future__ import annotations

from beammp_panel import VERSION
from beammp_panel.activity import get_activity, log_activity


def test_version_dans_info(client):
    assert client.get("/api/info").json()["version"] == VERSION


def test_activite_avec_ses_valeurs():
    log_activity("default", "player_leave", "Bob s'est déconnecté · 2m 3s de session", "Bob", {"user": "Bob", "duration": "2m 3s"})
    log_activity("default", "server_restart", "Serveur redémarré")
    restart, leave = get_activity("default", 2)
    assert leave["params"] == {"user": "Bob", "duration": "2m 3s"} and leave["message"].startswith("Bob")
    assert "params" not in restart                  # rien à composer : la clé seule suffit


def test_valeurs_toujours_en_texte():
    log_activity("default", "earth_pack_upload", "x", None, {"name": "Alpes", "items": 12})
    assert get_activity("default", 1)[0]["params"] == {"name": "Alpes", "items": "12"}
