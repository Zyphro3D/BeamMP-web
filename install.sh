#!/usr/bin/env bash
# Installation et mise à jour de BeamMP Panel sous Linux (Docker).
#
#   curl -fsSL https://raw.githubusercontent.com/Zyphro3D/BeamMP-web/HEAD/install.sh | sudo bash
#
# Relancer la même commande met le panel à jour : réglages (.env), base de données, mods et
# serveur BeamMP sont conservés. Fait tout ce qui était manuel : Docker (proposé s'il manque),
# téléchargement de la dernière release (manifeste signé Ed25519 + empreinte de l'archive),
# .env avec clé de session et mot de passe générés, BeamMP-Server (binaire officiel, empreinte
# confirmée par GitHub) et son service systemd, beammp-agent (redémarrage et mise à jour du
# serveur depuis le panel), construction et démarrage, attente que le panel réponde.
# Pose aussi l'unité de mise à jour : le bouton « Mettre à jour » du panel relance ce script
# avec --from-panel. Une mise à jour qui échoue revient à la version précédente.
#
# Une installation existante (faite à la main, avec git) est reprise telle quelle : son .env,
# ses services BeamMP et l'unité de l'agent ne sont pas modifiés ; le code de l'agent est
# remplacé par celui de la nouvelle version.
#
# Options : --dir DOSSIER         dossier d'installation (défaut : /opt/beammp-panel)
#           --server-dir DOSSIER  dossier de BeamMP-Server (défaut : DOSSIER/beammp-server)
#           --auth-key CLÉ        clé AuthKey du serveur (https://keymaster.beammp.com)
#           --version vX.Y.Z      version à installer (défaut : la dernière release)
#           --base URL            autre dossier de releases (tests) ; la signature reste exigée
#           --yes                 installe Docker sans poser la question s'il manque
#           --from-panel          mise à jour demandée depuis le panel (lancé par systemd)
set -euo pipefail

# Le script remplace son propre fichier pendant une mise à jour : bash lit le script au fil de
# l'exécution, on travaille donc sur une copie.
if [ -f "$0" ] && [ -z "${BEAMMP_PANEL_SELF:-}" ]; then
    self="$(mktemp)"
    cp "$0" "$self"
    BEAMMP_PANEL_SELF="$self" exec bash "$self" "$@"
fi

REPO="Zyphro3D/BeamMP-web"
DIR="/opt/beammp-panel"
SERVER_DIR=""
AUTH_KEY=""
VERSION=""
BASE=""
YES=0
FROM_PANEL=0
UNIT="beammp-panel-update"
SERVER_UNIT="beammp.service"
AGENT_UNIT="beammp-agent.service"
AGENT_DIR="/opt/beammp-agent"
AGENT_PORT=4445
GAME_PORT=30814
# Clé publique des releases (build/update_public.b64, au format PEM) : la clé privée ne quitte
# jamais la machine qui publie. server/tests/test_docker_update.py vérifie que les deux concordent.
PUBKEY_PEM="-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMkjI5f04gQW7TolQYoViqCxZoPI4efwjaxKFrWFNPYE=
-----END PUBLIC KEY-----"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; status error "$*"; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dir)        DIR="${2:?--dir attend un dossier}"; shift 2 ;;
        --server-dir) SERVER_DIR="${2:?--server-dir attend un dossier}"; shift 2 ;;
        --auth-key)   AUTH_KEY="${2:?--auth-key attend une clé}"; shift 2 ;;
        --version)    VERSION="${2:?--version attend vX.Y.Z}"; shift 2 ;;
        --base)       BASE="${2:?--base attend une adresse}"; shift 2 ;;
        --yes|-y)     YES=1; shift ;;
        --from-panel) FROM_PANEL=1; YES=1; shift ;;
        -h|--help)    sed -n '2,26p' "${BEAMMP_PANEL_SELF:-$0}" 2>/dev/null || true; exit 0 ;;
        *) printf 'Option inconnue : %s\n' "$1" >&2; exit 1 ;;
    esac
done
DIR="${DIR%/}"
SERVER_DIR="${SERVER_DIR:-$DIR/beammp-server}"
case "$DIR$SERVER_DIR" in *[[:space:]]*|*[\'\"\\\$]*) echo "Dossier refusé (espace ou caractère spécial) : $DIR / $SERVER_DIR" >&2; exit 1 ;; esac

# Avancement lu par la carte « Mise à jour du panel » (mode --from-panel). Le dossier update/ est
# accessible en écriture au panel : écriture dans un fichier temporaire créé ici puis renommé
# (un lien symbolique posé à la place de status.json serait remplacé, pas suivi).
status() {
    [ "$FROM_PANEL" -eq 1 ] || return 0
    local tmp msg
    tmp="$(mktemp "$DIR/update/.status.XXXXXX")" || return 0
    msg="$(printf '%s' "${2:-}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-300)"
    printf '{"phase": "%s", "message": "%s", "version": "%s", "updated_at": %s}\n' \
        "$1" "$msg" "${VERSION#v}" "$(date +%s)" > "$tmp"
    chmod 644 "$tmp"
    mv -f "$tmp" "$DIR/update/status.json"
}

[ "$(id -u)" -eq 0 ] || die "À lancer en root : curl -fsSL https://raw.githubusercontent.com/$REPO/HEAD/install.sh | sudo bash"

# Version du code en place (vide à la première installation)
installed_version() {
    # || true : sans fichier, sed échoue et « set -e -o pipefail » arrêterait le script sans message
    { sed -nE 's/^VERSION = "([^"]+)"/\1/p' "$DIR/server/beammp_panel/__init__.py" 2>/dev/null || true; } | head -1
}
# version_lt A B : A < B (X.Y.Z, suffixe -beta… plus ancien que la version finale)
version_lt() {
    python3 -I - "$1" "$2" <<'EOF'
import re, sys
def key(v):
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?", v.strip().lstrip("v"))
    if not m:
        sys.exit(2)
    pre = m.group(4)   # même ordre que updater.parse : beta.10 après beta.9
    return tuple(int(x) for x in m.groups()[:3]) + ((1,) if pre is None else (0,) + tuple(
        (0, int(x), "") if x.isdigit() else (1, 0, x) for x in pre.split(".")),)
sys.exit(0 if key(sys.argv[1]) < key(sys.argv[2]) else 1)
EOF
}

# Version X.Y.Z[-suffixe] lue dans la demande du panel (entrée standard), vide sinon
requested_version() {
    { grep -oE '"version": *"[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?"' || true; } | head -1 | sed -E 's/.*"([^"]+)"$/\1/'
}

if [ "$FROM_PANEL" -eq 1 ]; then
    exec >>"$DIR/update.log" 2>&1
    echo "──── $(date '+%F %T') mise à jour demandée depuis le panel"
    # Demande déposée par le panel : seule une version X.Y.Z[-suffixe] est lue, et la demande est
    # consommée tout de suite (l'unité ne se redéclenche pas en boucle si quelque chose échoue).
    req="$(head -c 4096 "$DIR/update/request.json" 2>/dev/null || true)"
    rm -f "$DIR/update/request.json"
    v="$(printf '%s' "$req" | requested_version)"
    [ -n "$v" ] || die "Demande de mise à jour illisible"
    VERSION="v$v"
    # Le panel ne peut demander qu'une version plus récente : pas de retour vers une version
    # signée mais ancienne (et peut-être vulnérable).
    current="$(installed_version)"
    [ -n "$current" ] && version_lt "$current" "$v" || die "Version $v refusée : la version installée est $current"
fi

# Question posée sur le terminal même quand le script arrive par « curl | bash » (stdin = le script)
ask_yes() {
    [ "$YES" -eq 1 ] && return 0
    [ -r /dev/tty ] || return 1
    local answer
    printf '%s [O/n] ' "$1" > /dev/tty
    read -r answer < /dev/tty || return 1
    case "$answer" in ""|o|O|oui|y|Y|yes) return 0 ;; *) return 1 ;; esac
}

pkg_install() {
    if command -v apt-get >/dev/null; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
    elif command -v dnf >/dev/null; then dnf install -y -q "$@" >/dev/null
    else die "Installez d'abord : $*"; fi
}

# ── 1. Prérequis ─────────────────────────────────────────────────────────────
for tool in curl unzip openssl python3; do
    command -v "$tool" >/dev/null || { say "Installation de $tool"; pkg_install "$tool"; }
done
command -v systemctl >/dev/null && [ -d /run/systemd/system ] || die "systemd est nécessaire (services BeamMP-Server, agent, mise à jour)."

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    warn "Docker (avec docker compose) n'est pas installé."
    if ask_yes "Installer Docker maintenant (script officiel get.docker.com) ?"; then
        curl -fsSL https://get.docker.com | sh
    else
        die "Docker est nécessaire : https://docs.docker.com/engine/install/ puis relancez ce script."
    fi
fi
docker info >/dev/null 2>&1 || { systemctl enable --now docker >/dev/null 2>&1 || true; }
docker info >/dev/null 2>&1 || die "Le service Docker ne répond pas (systemctl status docker)."
ok "Docker $(docker version --format '{{.Server.Version}}')"

# ── 2. Récupération et vérification du panel ─────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [ -n "${BEAMMP_PANEL_SELF:-}" ] && rm -f "$BEAMMP_PANEL_SELF"' EXIT
status download "Téléchargement de $VERSION"

# BEAMMP_PANEL_UPDATE_BASE (.env) : autre dossier de releases, pour tester une mise à jour avant
# publication. Sans danger : seul un manifeste signé par la clé ci-dessus est accepté.
[ -n "$BASE" ] || BASE="$(grep -m1 '^BEAMMP_PANEL_UPDATE_BASE=' "$DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true)"
if [ -z "$BASE" ]; then
    BASE="https://github.com/$REPO/releases/${VERSION:+download/$VERSION}"
    [ -n "$VERSION" ] || BASE="${BASE}latest/download"
fi
BASE="${BASE%/}"
case "$BASE" in https://*|http://127.0.0.1[:/]*|http://localhost[:/]*|file:///*) ;; *) die "Adresse de release refusée : $BASE" ;; esac

say "Téléchargement du manifeste ($BASE)"
curl -fsSL --max-filesize 262144 -o "$TMP/latest-stable.json" "$BASE/latest-stable.json" \
    || die "Manifeste introuvable : $BASE/latest-stable.json"
curl -fsSL --max-filesize 4096 -o "$TMP/sig.b64" "$BASE/latest-stable.json.sig" \
    || die "Signature du manifeste introuvable"
status verify "Vérification de la signature"
printf '%s\n' "$PUBKEY_PEM" > "$TMP/pub.pem"
python3 -I -c 'import base64,sys; s=open(sys.argv[1]).read().strip(); sys.stdout.buffer.write(base64.urlsafe_b64decode(s+"="*(-len(s)%4)))' \
    "$TMP/sig.b64" > "$TMP/sig.bin" || die "Signature illisible"
openssl pkeyutl -verify -pubin -inkey "$TMP/pub.pem" -rawin -in "$TMP/latest-stable.json" \
    -sigfile "$TMP/sig.bin" >/dev/null 2>&1 || die "Signature du manifeste invalide : release refusée"

# Manifeste signé : application, version et paquet Docker (nom, taille, empreinte, adresse)
read -r M_VERSION M_NAME M_SIZE M_SHA M_URL < <(python3 -I - "$TMP/latest-stable.json" <<'EOF'
import json, re, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
d = m.get("docker") or {}
v = str(m.get("version", ""))
ok = (m.get("app") == "beammp-panel" and m.get("channel") == "stable"
      and re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", v)
      and d.get("name") == f"beammp-panel-docker-{v}.zip"
      and isinstance(d.get("size"), int) and 0 < d["size"] < 200 * 1024 * 1024
      and re.fullmatch(r"[0-9a-f]{64}", str(d.get("sha256", "")))
      and re.fullmatch(r"[A-Za-z0-9:/._%-]+", str(d.get("url", ""))))
if not ok:
    sys.exit(1)
print(v, d["name"], d["size"], d["sha256"], d["url"])
EOF
) || die "Manifeste sans paquet Docker valide (release antérieure à 3.3.0 ?)"
[ -z "$VERSION" ] || [ "$M_VERSION" = "${VERSION#v}" ] || die "Le manifeste annonce $M_VERSION au lieu de $VERSION"
VERSION="v$M_VERSION"
# Le manifeste est signé, mais on limite quand même l'origine du paquet : releases du dépôt, ou
# le même dossier que le manifeste.
case "$M_URL" in "https://github.com/$REPO/releases/download/$VERSION/$M_NAME"|"$BASE/$M_NAME") ;;
    *) die "Adresse du paquet inattendue : $M_URL" ;; esac

say "Téléchargement du panel $VERSION"
status download "Téléchargement de $VERSION"
curl -fsSL --max-filesize "$M_SIZE" -o "$TMP/panel.zip" "$M_URL" || die "Téléchargement impossible"
[ "$(stat -c %s "$TMP/panel.zip")" = "$M_SIZE" ] && [ "$(sha256sum "$TMP/panel.zip" | cut -d' ' -f1)" = "$M_SHA" ] \
    || die "Empreinte SHA-256 de l'archive incorrecte : archive refusée"
ok "Signature et empreinte vérifiées ($VERSION)"

mkdir -p "$TMP/src"
# -DD : fichiers datés de maintenant. BuildKit ne renvoie au build que les fichiers dont la taille
# ou la date a changé : avec les dates de l'archive, un fichier modifié sans changer de taille
# (VERSION = "3.3.0" → "3.3.1") resterait l'ancien dans l'image.
unzip -q -DD "$TMP/panel.zip" -d "$TMP/src"
[ -f "$TMP/src/docker-compose.yml" ] && [ -f "$TMP/src/install.sh" ] || die "Archive inattendue (pas de docker-compose.yml)"

FIRST_INSTALL=1
[ -f "$DIR/.env" ] && FIRST_INSTALL=0
CURRENT="$(installed_version)"
if [ -n "$CURRENT" ] && [ "$FROM_PANEL" -eq 0 ] && version_lt "$M_VERSION" "$CURRENT"; then
    warn "Retour à une version plus ancienne ($CURRENT → $M_VERSION), demandé à la main"
fi
[ -d "$DIR/.git" ] && warn "Installation faite avec git détectée : les fichiers sont remplacés par ceux de la release (vos réglages restent)."

# ── 3. Sauvegarde pour le retour arrière (mise à jour seulement) ─────────────
# Code (hors données de l'utilisateur) et image en place : restaurés si la nouvelle version ne se
# construit pas ou si le panel ne répond plus. Rangés hors du dossier update/ partagé avec le panel.
ROLLBACK=0
APP_CID=""
[ -f "$DIR/docker-compose.yml" ] && APP_CID="$(cd "$DIR" && docker compose ps -q app 2>/dev/null | head -1 || true)"
if [ "$FIRST_INSTALL" -eq 0 ] && [ -n "$APP_CID" ]; then
    mkdir -p "$DIR/.rollback"
    tar -C "$DIR" --exclude=./.env --exclude=./.git --exclude=./backups --exclude=./update \
        --exclude=./.rollback --exclude=./update.log --exclude=./beammp-server --exclude=./data \
        --exclude=./frontend/node_modules -czf "$DIR/.rollback/code.tgz" .
    APP_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$APP_CID")"
    # Un tag garde l'image en place : sans lui, elle serait effacée dès qu'aucun conteneur ne
    # l'utilise (par le nom, que « docker tag » accepte aussi avec le stockage containerd).
    docker tag "$APP_IMAGE" beammp-panel-rollback:app
    ROLLBACK=1
fi

mkdir -p "$DIR"
# Les données de l'utilisateur ne sont pas dans l'archive (.env, base dans un volume Docker, mods,
# serveur) : la copier par-dessus remplace le code et garde tout le reste.
cp -a "$TMP/src/." "$DIR/"
cd "$DIR"
# Dossier appartenant à un utilisateur (installation faite à la main avec git) : les fichiers
# copiés lui reviennent, pour qu'il garde la main dessus
owner="$(stat -c %u:%g "$DIR")"
[ "$owner" = "0:0" ] || chown -R --from=0:0 "$owner" "$DIR"
ok "Panel $VERSION copié dans $DIR"

# Dossier partagé avec le panel (uid 1000 dans le conteneur) : demande et avancement
mkdir -p update backups
chown 1000:1000 update
chmod 755 update

# ── 4. Première installation : utilisateur, BeamMP-Server, réglages ──────────
rand() { head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-"$1"; }
IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
IP="${IP:-localhost}"
SUPERADMIN_PW=""
ASSET=""

# Le panel écrit les mods et ServerConfig.toml avec l'uid 1000 (utilisateur du conteneur) :
# BeamMP-Server tourne sous ce même uid pour garder la main sur ces fichiers.
run_user() {
    local u
    u="$(getent passwd 1000 | cut -d: -f1 || true)"
    if [ -z "$u" ]; then
        useradd --system --uid 1000 --user-group --home-dir "$SERVER_DIR" --no-create-home \
            --shell /usr/sbin/nologin beammp
        u=beammp
    fi
    printf '%s' "$u"
}

# AuthKey : clé du serveur sur keymaster.beammp.com (BeamMP-Server s'arrête sans elle)
valid_key() { printf '%s' "$1" | grep -qE '^[A-Za-z0-9-]{8,100}$'; }
if [ -n "$AUTH_KEY" ] && ! valid_key "$AUTH_KEY"; then die "Clé AuthKey au format inattendu"; fi

set_auth_key() {   # set_auth_key FICHIER CLÉ : remplace ou ajoute AuthKey dans [General]
    python3 -I - "$1" "$2" <<'EOF'
import re, sys
path, key = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
line = f'AuthKey = "{key}"'
if re.search(r"(?m)^AuthKey\s*=.*$", text):
    text = re.sub(r"(?m)^AuthKey\s*=.*$", lambda _m: line, text, count=1)
else:
    text = re.sub(r"(?m)^\[General\]\s*$", lambda _m: "[General]\n" + line, text, count=1)
open(path, "w", encoding="utf-8").write(text)
EOF
}

install_server() {
    local user="$1" arch id ver
    arch="$(uname -m)"; [ "$arch" = aarch64 ] && arch=arm64
    # Lu dans un sous-shell : /etc/os-release définit VERSION, qui écraserait celle du panel
    # shellcheck disable=SC1091
    id="$(. /etc/os-release && printf '%s' "${ID:-debian}")"
    # shellcheck disable=SC1091
    ver="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
    ASSET="BeamMP-Server.$id.$ver.$arch"
    mkdir -p "$SERVER_DIR/Resources/Client" "$SERVER_DIR/Resources/Server"
    if [ ! -x "$SERVER_DIR/BeamMP-Server" ]; then
        say "Téléchargement de BeamMP-Server ($ASSET)"
        read -r S_URL S_SHA < <(curl -fsSL "https://api.github.com/repos/BeamMP/BeamMP-Server/releases/latest" \
            | python3 -I -c '
import json, sys
name = sys.argv[1]
rel = json.load(sys.stdin)
for a in rel.get("assets", []):
    if a.get("name") == name and str(a.get("digest", "")).startswith("sha256:"):
        print(a["browser_download_url"], a["digest"][7:]); break
else:
    linux = sorted(a["name"] for a in rel.get("assets", []) if not a["name"].endswith(".exe"))
    sys.exit("pas de binaire " + name + " ; disponibles : " + ", ".join(linux))
' "$ASSET") || die "BeamMP-Server introuvable pour ce système ($ASSET)"
        case "$S_URL" in https://github.com/BeamMP/BeamMP-Server/releases/download/*) ;; *) die "Adresse inattendue : $S_URL" ;; esac
        curl -fsSL --max-filesize 209715200 -o "$TMP/BeamMP-Server" "$S_URL" || die "Téléchargement de BeamMP-Server impossible"
        [ "$(sha256sum "$TMP/BeamMP-Server" | cut -d' ' -f1)" = "$S_SHA" ] || die "Empreinte de BeamMP-Server incorrecte"
        install -m 755 "$TMP/BeamMP-Server" "$SERVER_DIR/BeamMP-Server"
        ok "BeamMP-Server installé (empreinte confirmée par GitHub)"
    fi
    # Bibliothèques manquantes (Lua 5.3 selon les versions de BeamMP-Server)
    # Sortie de ldd lue en entier (pas de « ldd | grep -q » : SIGPIPE + pipefail)
    local libs
    libs="$(ldd "$SERVER_DIR/BeamMP-Server" 2>/dev/null || true)"
    if printf '%s\n' "$libs" | grep -q "liblua.*not found" && command -v apt-get >/dev/null; then
        pkg_install liblua5.3-0
        libs="$(ldd "$SERVER_DIR/BeamMP-Server" 2>/dev/null || true)"
    fi
    if printf '%s\n' "$libs" | grep -q "not found"; then
        warn "Bibliothèques manquantes pour BeamMP-Server : $(printf '%s\n' "$libs" | grep 'not found' | awk '{print $1}' | tr '\n' ' ')"
    fi
    if [ ! -f "$SERVER_DIR/ServerConfig.toml" ]; then
        cat > "$SERVER_DIR/ServerConfig.toml" <<EOF
[General]
Name = "BeamMP Panel"
Port = $GAME_PORT
AuthKey = ""
ResourceFolder = "Resources"
MaxPlayers = 8
MaxCars = 1
Map = "/levels/gridmap_v2/info.json"
Description = "BeamMP server"
EOF
    fi
    : > "$SERVER_DIR/Server.log"
    chown -R "$user:" "$SERVER_DIR"
    if [ ! -f "/etc/systemd/system/$SERVER_UNIT" ]; then
        cat > "/etc/systemd/system/$SERVER_UNIT" <<EOF
[Unit]
Description=BeamMP-Server (géré par BeamMP Panel)
After=network-online.target
Wants=network-online.target

[Service]
User=$user
WorkingDirectory=$SERVER_DIR
ExecStart=$SERVER_DIR/BeamMP-Server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable "$SERVER_UNIT" >/dev/null 2>&1
        ok "Service $SERVER_UNIT créé"
    fi
}

RUN_USER=""
if [ "$FIRST_INSTALL" -eq 1 ]; then
    RUN_USER="$(run_user)"
    install_server "$RUN_USER"
    if [ -z "$AUTH_KEY" ] && [ -r /dev/tty ] && [ "$YES" -eq 0 ]; then
        printf 'Clé AuthKey du serveur (https://keymaster.beammp.com), Entrée pour plus tard : ' > /dev/tty
        read -r AUTH_KEY < /dev/tty || AUTH_KEY=""
        if [ -n "$AUTH_KEY" ] && ! valid_key "$AUTH_KEY"; then warn "Clé au format inattendu : ignorée"; AUTH_KEY=""; fi
    fi
    SUPERADMIN_PW="$(rand 20)"
    sed -e "s|^JWT_SECRET=.*|JWT_SECRET=$(rand 64)|" \
        -e "s|^SUPERADMIN_PASSWORD=.*|SUPERADMIN_PASSWORD=$SUPERADMIN_PW|" \
        -e "s|^BEAMMP_SERVER_IP=.*|BEAMMP_SERVER_IP=$IP|" \
        -e "s|^BEAMMP_SERVER_PORT=.*|BEAMMP_SERVER_PORT=$GAME_PORT|" \
        -e "s|^BEAMMP_RESOURCES_PATH=.*|BEAMMP_RESOURCES_PATH=$SERVER_DIR/Resources|" \
        -e "s|^BEAMMP_LOG_DIR=.*|BEAMMP_LOG_DIR=$SERVER_DIR|" \
        -e "s|^BEAMMP_LOG_PATH=.*|BEAMMP_LOG_PATH=$SERVER_DIR/Server.log|" \
        -e "s|^BEAMMP_CONFIG_PATH=.*|BEAMMP_CONFIG_PATH=$SERVER_DIR/ServerConfig.toml|" \
        .env.example > .env
    chmod 600 .env
    ok "Réglages créés (.env) : clé de session et mot de passe générés"
else
    ok "Réglages existants conservés (.env)"
fi

# Clé AuthKey donnée (première installation, ou relance avec --auth-key) : écrite dans la
# configuration du serveur que ce script gère
if [ -n "$AUTH_KEY" ]; then
    if [ -f "$SERVER_DIR/ServerConfig.toml" ]; then
        set_auth_key "$SERVER_DIR/ServerConfig.toml" "$AUTH_KEY"
        ok "Clé AuthKey enregistrée"
    else
        warn "--auth-key ignorée : pas de $SERVER_DIR/ServerConfig.toml (serveur installé ailleurs)"
    fi
fi

# ── 5. Construction ──────────────────────────────────────────────────────────
APP_PORT="$(grep -m1 '^APP_PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '\r' || true)"
APP_PORT="${APP_PORT:-3000}"

panel_up() {   # le panel répond, dans la version attendue
    local deadline=$(( $(date +%s) + ${2:-300} )) headers
    while [ "$(date +%s)" -lt "$deadline" ]; do
        # En-têtes lus en entier d'abord : « curl | grep -q » ferait échouer curl (SIGPIPE) avec pipefail
        headers="$(curl -fsS -m 5 -D - -o /dev/null "http://127.0.0.1:$APP_PORT/api/info" 2>/dev/null || true)"
        if printf '%s\n' "$headers" | tr -d '\r' | grep -Fxqi "x-beammp-panel-version: ${1#v}"; then
            return 0
        fi
        sleep 5
    done
    return 1
}

# Chemin du code de l'agent d'après son unité (installations faites à la main comprises)
agent_script() {
    { sed -nE 's|^ExecStart=.*python3 +([^ ]+beammp-agent\.py).*|\1|p' "/etc/systemd/system/$AGENT_UNIT" 2>/dev/null || true; } | head -1
}
# Recopie le code de l'agent du dossier courant, puis le redémarre s'il tournait
install_agent_code() {
    local target
    target="$(agent_script)"
    [ -n "$target" ] || return 0
    if ! cmp -s "$DIR/agent/beammp-agent.py" "$target"; then
        install -m 755 "$DIR/agent/beammp-agent.py" "$target"
        systemctl restart "$AGENT_UNIT" >/dev/null 2>&1 || true
        ok "beammp-agent mis à jour ($target)"
    fi
}

rollback() {
    set +e    # aller au bout du retour arrière même si une étape échoue
    warn "$1 : retour à la version précédente"
    status rollback "$1"
    tar -C "$DIR" -xzf "$DIR/.rollback/code.tgz"
    docker tag beammp-panel-rollback:app "$APP_IMAGE"
    # --force-recreate : seul le contenu de l'image a changé, compose garderait le conteneur cassé
    docker compose up -d --no-build --force-recreate app
    install_agent_code
    if panel_up "$CURRENT" 180; then
        # Version précédente revenue : la sauvegarde ne sert plus
        rm -rf "$DIR/.rollback"
        docker rmi beammp-panel-rollback:app >/dev/null 2>&1
        status rolled_back "$1"
        printf '\033[1;31m ✗\033[0m %s\n' "Mise à jour annulée ($1) : version précédente rétablie" >&2
    else
        # Sauvegarde gardée ($DIR/.rollback, image beammp-panel-rollback:app) pour réparer à la main
        status error "$1, et la version précédente ne répond pas non plus"
        printf '\033[1;31m ✗\033[0m %s\n' "Mise à jour annulée ($1), mais $CURRENT ne répond pas : docker compose -f $DIR/docker-compose.yml logs app" >&2
    fi
    exit 1
}

status build "Construction de $VERSION"
say "Construction (premier lancement : quelques minutes)"
# Construction seule : l'ancien conteneur continue de répondre jusqu'au redémarrage
if ! docker compose build app; then
    [ "$ROLLBACK" -eq 1 ] && rollback "construction impossible"
    die "La construction a échoué (voir ci-dessus)"
fi
# Première installation : crée le réseau Docker du panel, dont la passerelle sert à l'agent
[ "$FIRST_INSTALL" -eq 0 ] || docker compose up --no-start app

# ── 6. beammp-agent : redémarrage et mise à jour du serveur depuis le panel ──
if [ -f "/etc/systemd/system/$AGENT_UNIT" ]; then
    install_agent_code
elif [ "$FIRST_INSTALL" -eq 1 ]; then
    PROJECT="$(docker compose config --format json | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
    GW="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "${PROJECT}_default" 2>/dev/null || true)"
    printf '%s' "$GW" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || die "Passerelle du réseau Docker introuvable (${PROJECT}_default)"
    mkdir -p "$AGENT_DIR"
    install -m 755 agent/beammp-agent.py "$AGENT_DIR/beammp-agent.py"
    if [ ! -f /etc/beammp-agent.env ]; then
        ( umask 077; printf 'RESTART_TOKEN=%s\n' "$(rand 64)" > /etc/beammp-agent.env )
    fi
    TOKEN="$(sed -n 's/^RESTART_TOKEN=//p' /etc/beammp-agent.env)"
    SYSTEMCTL="$(command -v systemctl)"
    printf '%s ALL=(root) NOPASSWD: %s restart %s\n' "$RUN_USER" "$SYSTEMCTL" "$SERVER_UNIT" > "$TMP/sudoers"
    visudo -cf "$TMP/sudoers" >/dev/null || die "Règle sudoers refusée par visudo"
    install -m 440 "$TMP/sudoers" /etc/sudoers.d/beammp-agent
    sed -e "s|^User=.*|User=$RUN_USER|" \
        -e "s|^ExecStart=.*|ExecStart=/usr/bin/python3 $AGENT_DIR/beammp-agent.py|" \
        -e "s|^Environment=ALLOWED_SERVICES=.*|Environment=ALLOWED_SERVICES=$SERVER_UNIT|" \
        -e "s|^Environment=AGENT_HOST=.*|Environment=AGENT_HOST=$GW|" \
        -e "s|^Environment=AGENT_PORT=.*|Environment=AGENT_PORT=$AGENT_PORT|" \
        -e "s|^#Environment=BEAMMP_BINARY_PATH=.*|Environment=BEAMMP_BINARY_PATH=$SERVER_DIR/BeamMP-Server|" \
        -e "s|^#ReadWritePaths=.*|ReadWritePaths=$SERVER_DIR|" \
        agent/beammp-agent.service > "/etc/systemd/system/$AGENT_UNIT"
    chmod 600 "/etc/systemd/system/$AGENT_UNIT"
    systemctl daemon-reload
    {
        echo
        echo "# beammp-agent (posé par install.sh)"
        echo "BEAMMP_AGENT_URL=http://$GW:$AGENT_PORT"
        echo "BEAMMP_AGENT_TOKEN=$TOKEN"
        echo "BEAMMP_AGENT_SERVICE=$SERVER_UNIT"
        echo "BEAMMP_AGENT_ASSET=$ASSET"
    } >> .env
    ok "beammp-agent installé (écoute sur $GW:$AGENT_PORT, réseau Docker du panel seulement)"
else
    warn "beammp-agent absent : boutons Redémarrer / Mettre à jour le serveur indisponibles (voir README)"
fi

# ── 7. Démarrage ─────────────────────────────────────────────────────────────
status restart "Redémarrage du panel"
docker compose up -d --force-recreate app
[ -f "/etc/systemd/system/$AGENT_UNIT" ] && systemctl enable --now "$AGENT_UNIT" >/dev/null 2>&1 || true

say "Attente du panel"
if ! panel_up "$VERSION"; then
    [ "$ROLLBACK" -eq 1 ] && rollback "le panel ne répond pas après la mise à jour"
    die "Le panel ne répond pas : docker compose -f $DIR/docker-compose.yml logs app"
fi

# Serveur BeamMP géré par ce script : démarré dès qu'il a sa clé (relancé si la clé vient de changer)
if [ -f "$SERVER_DIR/ServerConfig.toml" ] && grep -q "Description=BeamMP-Server (géré par BeamMP Panel)" "/etc/systemd/system/$SERVER_UNIT" 2>/dev/null; then
    if grep -qE '^AuthKey *= *"[^"]+"' "$SERVER_DIR/ServerConfig.toml"; then
        if [ -n "$AUTH_KEY" ]; then systemctl restart "$SERVER_UNIT"; else systemctl start "$SERVER_UNIT"; fi
        ok "BeamMP-Server démarré (port $GAME_PORT)"
    else
        warn "BeamMP-Server attend sa clé AuthKey : relancez ce script avec --auth-key VOTRE_CLÉ"
    fi
fi

# ── 8. Mise à jour depuis le panel : l'unité relance ce script ───────────────
cat > "/etc/systemd/system/$UNIT.service" <<EOF
[Unit]
Description=Mise à jour de BeamMP Panel demandée depuis le panel

[Service]
Type=oneshot
ExecStart=/bin/bash $DIR/install.sh --dir $DIR --server-dir $SERVER_DIR --from-panel
TimeoutStartSec=3600
EOF
cat > "/etc/systemd/system/$UNIT.path" <<EOF
[Unit]
Description=Surveille les demandes de mise à jour de BeamMP Panel

[Path]
PathExists=$DIR/update/request.json
Unit=$UNIT.service

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$UNIT.path" >/dev/null 2>&1
printf '{"agent": "systemd", "installed_at": %s}\n' "$(date +%s)" > update/agent.json
ok "Mise à jour depuis le panel activée (unité $UNIT)"

rm -rf "$DIR/.rollback"
docker rmi beammp-panel-rollback:app >/dev/null 2>&1 || true
status "done" "Panel $VERSION en ligne"
echo
ok "BeamMP Panel $VERSION en ligne / online : http://$IP:$APP_PORT"
if [ "$FIRST_INSTALL" -eq 1 ]; then
    cat <<EOF

   Identifiants (à changer dans le panel) / Credentials (change them in the panel):
     $(grep -m1 '^SUPERADMIN_USERNAME=' .env | cut -d= -f2) / $SUPERADMIN_PW

   Serveur BeamMP : $SERVER_DIR (service $SERVER_UNIT). Port à ouvrir vers cette machine pour
   les joueurs : $GAME_PORT TCP+UDP. Sans clé AuthKey, relancez ce script avec --auth-key CLÉ.

   BeamMP server: $SERVER_DIR ($SERVER_UNIT service). Port to open to this machine for
   players: $GAME_PORT TCP+UDP. No AuthKey yet? Run this script again with --auth-key KEY.
EOF
fi
