# BeamMP Panel

Interface d'administration web pour serveur BeamMP.
Gestion des mods, cartes, configuration, logs et joueurs — déployable en un seul conteneur Docker.

Fonctionne sur **Linux** et **Windows** (Docker Desktop).

---

## Sommaire

1. [Prérequis](#prérequis)
2. [Installation](#installation)
3. [Configuration `.env`](#configuration-env)
4. [Démarrage](#démarrage)
5. [Premier démarrage](#premier-démarrage)
6. [Reverse proxy HTTPS](#reverse-proxy-https)
7. [Multi-instance](#multi-instance)
8. [Redémarrage du serveur](#redémarrage-du-serveur)
9. [Configs pré-établies](#configs-pré-établies)
10. [Mise à jour](#mise-à-jour)
11. [Sauvegarde](#sauvegarde)
12. [Migration depuis la V1 (MariaDB)](#migration-depuis-la-v1-mariadb)
13. [Variables d'environnement](#variables-denvironnement)
14. [Rôles et comptes](#rôles-et-comptes)
15. [Sécurité](#sécurité)

---

## Prérequis

- **Docker Engine 24+** et **Docker Compose v2**
  - Linux : Docker CE (dépôt officiel `get.docker.com`)
  - Windows : Docker Desktop
- Un serveur BeamMP fonctionnel sur la même machine

---

## Installation

```bash
git clone <repo> beammp-panel
cd beammp-panel
cp .env.example .env
# Éditer .env (voir section ci-dessous)
```

---

## Configuration `.env`

**Variables obligatoires avant le premier démarrage :**

```env
# Clé secrète JWT — générer avec : openssl rand -hex 32
JWT_SECRET=

# Mot de passe PostgreSQL
POSTGRES_PASSWORD=

# Compte SuperAdmin créé automatiquement si la base est vide
SUPERADMIN_USERNAME=admin
SUPERADMIN_PASSWORD=
```

**Chemins BeamMP — à adapter à votre installation :**

```env
# Linux
BEAMMP_RESOURCES_PATH=/home/user/BeamMP-Server/Resources
BEAMMP_LOG_PATH=/home/user/BeamMP-Server/Server.log
BEAMMP_CONFIG_PATH=/home/user/BeamMP-Server/ServerConfig.toml

# Windows (Docker Desktop)
BEAMMP_RESOURCES_PATH=C:\Users\user\BeamMP-Server\Resources
BEAMMP_LOG_PATH=C:\Users\user\BeamMP-Server\Server.log
BEAMMP_CONFIG_PATH=C:\Users\user\BeamMP-Server\ServerConfig.toml
```

> Ces chemins sont les chemins **hôte**. Docker les monte automatiquement
> en tant que volumes dans le conteneur (toujours sous `/beammp/...` côté container).

**Si le panel est derrière un reverse proxy HTTPS :**

```env
COOKIE_SECURE=true
```

---

## Démarrage

```bash
# Premier démarrage / rebuild
docker compose up -d --build

# Redémarrer sans rebuild
docker compose up -d

# Voir les logs
docker compose logs -f app
```

---

## Premier démarrage

1. Ouvrir `http://localhost:3000` (ou votre domaine)
2. Se connecter avec le compte `SUPERADMIN_USERNAME` / `SUPERADMIN_PASSWORD` défini dans `.env`

> `SUPERADMIN_USERNAME` et `SUPERADMIN_PASSWORD` ne créent le compte **que si la base est vide**.
> Ils peuvent être supprimés du `.env` après le premier démarrage.

**Import des mods existants :**

Si des mods sont déjà présents dans le dossier `Resources/` du serveur BeamMP, utiliser
la fonctionnalité **Scan & Import** (sidebar → Import) pour les enregistrer automatiquement
en base de données. Le scan extrait le nom depuis `info.json` et l'image de prévisualisation
depuis le zip.

**Images des mods/véhicules/cartes :**

- **Automatique** — à l'upload (formulaire simple ou Scan & Import), le panel cherche une
  image de prévisualisation dans l'archive (`preview.jpg`, `icon.png`, la texture par défaut
  d'un véhicule, une image sous `levels/<nom>/`…) et la génère en `.webp`. Aucune garantie
  de résultat : de nombreux mods ne fournissent pas d'image exploitable dans ce sens.
- **Manuelle** — l'icône image sur chaque carte (mods, véhicules, cartes) permet de choisir
  sa propre image à tout moment, y compris pour en remplacer une déjà présente.
- **Par défaut** — sans image (ni automatique ni manuelle), une icône générique par type
  (véhicule/mod/carte) s'affiche à la place.

---

## Reverse proxy HTTPS

Exemple avec **Caddy** :

```caddy
panel.mondomaine.com {
    reverse_proxy localhost:3000
}
```

Ajouter dans `.env` :

```env
COOKIE_SECURE=true
# Si frontend sur domaine différent du port par défaut :
# ALLOWED_ORIGIN=https://panel.mondomaine.com
```

Puis redémarrer : `docker compose up -d`

> **Note rate limiting Caddy :** Si vous utilisez un rate limit global sur `/api*`,
> le dashboard effectue plusieurs appels API au chargement et peut déclencher la limite.
> Appliquez le rate limit uniquement sur `/api/auth/login*`.
> Le backend gère déjà son propre rate limit sur cet endpoint (5 req/min).

---

## Multi-instance

Le panel peut gérer plusieurs serveurs BeamMP depuis une seule interface.

### Configuration `.env`

```env
INSTANCES=main,event

INSTANCE_MAIN_NAME=Serveur Principal
INSTANCE_MAIN_SERVER_IP=1.2.3.4
INSTANCE_MAIN_SERVER_PORT=30814
INSTANCE_MAIN_BEAMMP_RESOURCES_PATH=/beammp/main/resources
INSTANCE_MAIN_BEAMMP_LOG_PATH=/beammp/main/server.log
INSTANCE_MAIN_BEAMMP_CONFIG_PATH=/beammp/main/ServerConfig.toml
INSTANCE_MAIN_AGENT_SERVICE=beammp-main.service

INSTANCE_EVENT_NAME=Serveur Évènement
INSTANCE_EVENT_SERVER_IP=1.2.3.4
INSTANCE_EVENT_SERVER_PORT=30815
INSTANCE_EVENT_BEAMMP_RESOURCES_PATH=/beammp/event/resources
INSTANCE_EVENT_BEAMMP_LOG_PATH=/beammp/event/server.log
INSTANCE_EVENT_BEAMMP_CONFIG_PATH=/beammp/event/ServerConfig.toml
INSTANCE_EVENT_AGENT_SERVICE=beammp-event.service
```

`BEAMMP_AGENT_URL`/`BEAMMP_AGENT_TOKEN` restent globaux (un seul agent par
hôte) — seul `AGENT_SERVICE` varie par instance, pour cibler le bon service
systemd au redémarrage.

### Volumes `docker-compose.yml`

Ajouter un volume par instance sous `services.app.volumes` :

```yaml
volumes:
  - app_images:/app/images
  - /host/main/Resources:/beammp/main/resources
  - /host/main/Server.log:/beammp/main/server.log:ro
  - /host/main/ServerConfig.toml:/beammp/main/ServerConfig.toml
  - /host/event/Resources:/beammp/event/resources
  - /host/event/Server.log:/beammp/event/server.log:ro
  - /host/event/ServerConfig.toml:/beammp/event/ServerConfig.toml
```

---

## Redémarrage du serveur

Le panel tourne en conteneur Docker et n'a pas accès à `systemctl` de l'hôte —
le bouton "Redémarrer le serveur" passe donc par **beammp-agent**, un petit
daemon Python (aucune dépendance) installé sur l'hôte, hors Docker.

### Installation

```bash
sudo mkdir -p /opt/beammp-agent
sudo cp beammp-agent.py /opt/beammp-agent/
sudo cp beammp-agent.service /etc/systemd/system/
sudo chmod +x /opt/beammp-agent/beammp-agent.py
```

Créer `/etc/beammp-agent.env` (**jamais** dans le unit file, qui est lisible
par tout le monde par défaut) :

```bash
sudo sh -c 'echo "RESTART_TOKEN=$(openssl rand -hex 32)" > /etc/beammp-agent.env'
sudo chmod 600 /etc/beammp-agent.env
sudo chown root:root /etc/beammp-agent.env
```

Éditer `/etc/systemd/system/beammp-agent.service` :

- `ALLOWED_SERVICES` — nom(s) du/des service(s) systemd du serveur BeamMP
  (whitelist stricte, l'agent refuse tout service hors de cette liste)
- `AGENT_HOST` — **ne pas** utiliser `0.0.0.0` ni l'IP LAN de la machine.
  Utiliser l'IP de la passerelle du réseau Docker du projet
  (`docker network inspect beammp-panel_default` → `Gateway`, typiquement
  `172.18.0.1` ou `172.17.0.1`) : l'agent reste joignable depuis le
  conteneur du panel via sa route par défaut, mais injoignable depuis le
  réseau local.

```bash
sudo chmod 600 /etc/systemd/system/beammp-agent.service   # contient des infos internes, pas de secret
sudo systemctl daemon-reload
sudo systemctl enable --now beammp-agent
curl http://<AGENT_HOST>:4445/health   # depuis l'hôte, doit répondre {"ok": true, ...}
```

Renseigner dans le `.env` du panel :

```env
BEAMMP_AGENT_URL=http://172.18.0.1:4445
BEAMMP_AGENT_TOKEN=<le même RESTART_TOKEN que /etc/beammp-agent.env>
BEAMMP_AGENT_SERVICE=beammp.service
```

Sans ces trois variables, le bouton de redémarrage reste désactivé (tooltip
"Restart non configuré") plutôt que d'échouer au clic.

> Si le réseau Docker du projet est un jour supprimé et recréé
> (`docker compose down` puis `up`, pas un simple `restart`), l'IP de
> passerelle peut changer — revérifier `AGENT_HOST` et `BEAMMP_AGENT_URL`
> ensemble dans ce cas.

### Mise à jour du serveur BeamMP (binaire du jeu)

À ne pas confondre avec la mise à jour du panel lui-même (section suivante).
Un bouton dans *Configuration* télécharge et installe la dernière release
[BeamMP-Server](https://github.com/BeamMP/BeamMP-Server/releases) officielle
via beammp-agent, vérifie son empreinte sha256 (fournie par l'API GitHub)
avant toute installation, sauvegarde le binaire précédent
(`BeamMP-Server.bak-<timestamp>`, à supprimer manuellement une fois la mise
à jour confirmée stable), puis redémarre le service.

**Activation** (en plus de la config restart ci-dessus) :

1. Renseigner `BEAMMP_BINARY_PATH` dans `beammp-agent.service` (chemin vers
   l'exécutable `BeamMP-Server`) et `ReadWritePaths=<dossier du binaire>`
   dans la section `[Service]` (`ProtectSystem=strict` rend le reste du
   système en lecture seule pour l'agent — sans ça, l'installation échoue).
2. Dans le `.env` du panel, ajouter `BEAMMP_AGENT_ASSET` — le suffixe exact
   d'un asset de la page releases (ex. `debian.13.x86_64`, à déterminer via
   `uname -m` + `cat /etc/os-release` sur l'hôte).
3. `sudo systemctl daemon-reload && sudo systemctl restart beammp-agent`

Sans `BEAMMP_AGENT_ASSET`, le bloc "Mise à jour du serveur" n'apparaît pas
dans Configuration (redémarrage seul reste disponible, indépendamment).

---

## Configs pré-établies

Section *Configs* — bascule d'un scénario serveur à l'autre en un clic
(ex. "Soirée Muscle Cars" : tel jeu de véhicules + telle carte) au lieu de
cocher les mods un par un.

Une config = un nom + une liste de mods/véhicules à activer + une carte.
**Appliquer** une config :

1. Active exactement les mods/véhicules listés, désactive tout le reste
   (déplace les fichiers entre `Client/` et `inactive_mod/` comme le ferait
   une bascule manuelle).
2. Active la carte choisie (si renseignée) — même mécanisme que *Cartes*.
3. Redémarre le serveur automatiquement si beammp-agent est configuré
   (sinon : "redémarrage requis", comme le reste du panel).

Un mod/véhicule supprimé depuis la sauvegarde de la config est **ignoré
silencieusement** à l'application plutôt que de la rendre inutilisable — le
résultat affiché indique combien ont été ignorés.

Les configs restent éditables à tout moment (ajout/retrait d'éléments,
changement de carte, renommage) depuis l'icône crayon de chaque config.
Le bouton "Utiliser les actifs actuels" dans l'éditeur pré-remplit la
sélection avec l'état actif du moment — pratique pour créer une config à
partir d'une configuration déjà en place.

---

## Mise à jour

```bash
git pull
docker compose up -d --build
```

Les données PostgreSQL sont conservées dans le volume `postgres_data`.
Les migrations de schéma s'appliquent automatiquement au démarrage.

Voir [CHANGELOG.md](./CHANGELOG.md) pour le détail des versions.

---

## Sauvegarde

Le volume `postgres_data` est la seule copie des comptes, joueurs connus, mods et
historique — sans sauvegarde, sa perte (erreur `docker volume rm`, disque
corrompu, migration de machine) est irréversible.

```bash
./scripts/backup-postgres.sh            # dump vers ./backups/, gardé 14 jours
./scripts/backup-postgres.sh /mnt/nas    # ou un dossier externe au host Docker
```

À planifier via cron sur l'hôte (pas dans le conteneur) — chemin absolu vers
le script obligatoire (cron ne démarre pas dans le dossier du projet), et
`/var/log/` n'est en général pas accessible en écriture pour un utilisateur
non-root, d'où un fichier de log dans le dossier du projet plutôt que
`/var/log/` :

```cron
0 3 * * * /opt/app-docker/beammp-panel/scripts/backup-postgres.sh >> /opt/app-docker/beammp-panel/backup.log 2>&1
```

Restauration (adapter `$POSTGRES_USER`/`$POSTGRES_DB` à votre `.env` si personnalisés) :

```bash
gunzip -c backups/beammp-panel-20260101-030000.sql.gz | docker compose exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB"
```

> Testez périodiquement une restauration réelle — une sauvegarde jamais restaurée n'est qu'une hypothèse.

---

## Migration depuis la V1 (MariaDB)

`scripts/migrate-v1-to-v2.mjs` reprend les données de l'ancien panel (PHP +
MariaDB) une fois les mods déjà enregistrés en V2 via **Scan & Import**.
Mode aperçu par défaut (aucune écriture sans `--apply`).

**Prérequis** — le site V1 (dossier contenant son `.env` et `DATA/images/` +
`DATA/descriptions/`) doit être accessible en lecture depuis la machine qui
lance le script, et sa base MariaDB démarrée et joignable (`DB_HOST`/
`DB_NAME`/`DB_USER`/`DB_PASSWORD` sont lus directement depuis le `.env` du
site V1, pas besoin de les ressaisir).

```bash
# Aperçu (rien n'est modifié)
node scripts/migrate-v1-to-v2.mjs --v1-root=/var/www/mon-ancien-site

# Application réelle
node scripts/migrate-v1-to-v2.mjs --v1-root=/var/www/mon-ancien-site --apply
```

### Ce qui est repris

| Donnée V1 | Effet côté V2 | Détail |
|---|---|---|
| Cartes officielles BeamNG (`map_officielle = 1`) | `mods` (nouvelle ligne, `is_official=true`) | Ces cartes du jeu de base (sans `.zip`) n'ont aucun chemin de création côté V2 en dehors de ce script — absentes du catalogue tant qu'elles n'ont pas été importées ainsi. Créées **inactives** ; jamais activées automatiquement. |
| Images (`beammp_Officiel.image`) | `mods.image` | Pour chaque mod déjà présent en V2 (même `filename`), l'image V1 **remplace** l'image actuelle (l'extraction automatique depuis le zip donne souvent un résultat de moins bonne qualité qu'une image choisie à la main). |
| Descriptions (`beammp_Officiel.description`) | `mods.description` | Ne **remplit que les descriptions V2 actuellement vides** (jamais d'écrasement — contrairement aux images, c'est du texte éditorial qui a pu être réécrit côté V2). Les descriptions V1 auto-générées ("Description non fournie.", "Description pour X") sont ignorées. |
| Joueurs (`beammp_users_Officiel`) | `known_players` | Fusionné avec les stats V2 existantes plutôt qu'écrasé : `connection_count`/temps de jeu s'additionnent (périodes disjointes avant/après bascule), les dates prennent la plus ancienne/récente des deux sources. Le rang (🥉🥈🥇💎, visible dans *Joueurs*) est recalculé automatiquement depuis `connection_count` — rien à migrer séparément. |
| Mods sans équivalent V2 | *(rapport seulement, aucune écriture)* | Un mod ne peut pas être recréé sans son `.zip` — le script liste ceux qui n'ont pas de ligne V2 correspondante, à traiter via **Scan & Import** si le fichier est toujours dans `Resources/`. |

**Non repris, volontairement** : les comptes admin V1 (`users`) — schéma de
mot de passe différent, et V2 a son propre flux de compte (demande +
approbation). Créer les comptes nécessaires depuis *Administration*.

**Idempotent** pour les images (une resynchronisation écrase avec la même
valeur) et les descriptions (ne touche jamais une ligne déjà remplie), mais
**pas** pour les joueurs si relancé avec les mêmes données V1 — la fusion
additionne les compteurs à chaque exécution. Ne lancer l'import joueurs
qu'une fois par site V1 source.

---

## Variables d'environnement

### Application

| Variable | Défaut | Obligatoire | Description |
|---|---|---|---|
| `APP_PORT` | `3000` | | Port d'écoute du panel (côté hôte — voir aussi `PORT` ci-dessous) |
| `JWT_SECRET` | — | **Oui** | Clé secrète JWT — min 32 chars (`openssl rand -hex 32`) |
| `COOKIE_SECURE` | `false` | | Mettre `true` derrière un reverse proxy HTTPS |
| `ALLOWED_ORIGIN` | — | | URL du panel pour CORS si domaine différent |
| `TRUST_PROXY_HOPS` | — | | Nombre de reverse proxy en amont (ex. `1`). Laisser vide si le panel est exposé directement — sinon le rate-limit de login peut être contourné en forgeant `X-Forwarded-For` |
| `SUPERADMIN_USERNAME` | — | | Login du superadmin (premier démarrage uniquement) |
| `SUPERADMIN_PASSWORD` | — | | Mot de passe min 8 chars (premier démarrage uniquement) |
| `PORT` | `3000` | | Avancé — port interne au conteneur. Ne pas confondre avec `APP_PORT` |
| `IMAGES_PATH` | `/app/images` | | Avancé — chemin interne au conteneur pour les images de mods |
| `INSTANCE_NAME` | `BeamMP Server` | | Nom affiché en mode instance unique |

### Base de données

| Variable | Défaut | Description |
|---|---|---|
| `POSTGRES_HOST` | `postgres` | Hôte PostgreSQL |
| `POSTGRES_PORT` | `5432` | Port PostgreSQL |
| `POSTGRES_DB` | `beammp` | Nom de la base |
| `POSTGRES_USER` | `beammp` | Utilisateur |
| `POSTGRES_PASSWORD` | `beammp` | **Changer en production** |

### Instance BeamMP

| Variable | Défaut | Description |
|---|---|---|
| `BEAMMP_SERVER_IP` | — | IP publique du serveur (statut temps réel) |
| `BEAMMP_SERVER_PORT` | — | Port UDP du serveur BeamMP |
| `BEAMMP_RESOURCES_PATH` | — | Chemin hôte vers `Resources/` |
| `BEAMMP_LOG_PATH` | — | Chemin hôte vers `Server.log` |
| `BEAMMP_CONFIG_PATH` | — | Chemin hôte vers `ServerConfig.toml` |
| `BEAMMP_API_HOST` | `localhost` | Host de l'API HTTP BeamMP (optionnel) |
| `BEAMMP_API_PORT` | `4444` | Port de l'API HTTP BeamMP |

### Agent de redémarrage (optionnel — voir [Redémarrage du serveur](#redémarrage-du-serveur))

| Variable | Défaut | Description |
|---|---|---|
| `BEAMMP_AGENT_URL` | — | URL de beammp-agent sur l'hôte (IP de la passerelle Docker, pas `0.0.0.0`/IP LAN) |
| `BEAMMP_AGENT_TOKEN` | — | Doit correspondre à `RESTART_TOKEN` dans `/etc/beammp-agent.env` |
| `BEAMMP_AGENT_SERVICE` | — | Nom du service systemd à redémarrer (doit être dans `ALLOWED_SERVICES` côté agent) |

### Discord (optionnel)

| Variable | Défaut | Description |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | — | Webhook global (fallback) |
| `DISCORD_WEBHOOK_RESTART` | — | Webhook redémarrages |
| `DISCORD_WEBHOOK_PLAYERS` | — | Webhook connexions joueurs |
| `DISCORD_WEBHOOK_MODS` | — | Webhook uploads mods et changements de carte |
| `DISCORD_SERVER_URL` | — | Lien invitation Discord dans le panel |
| `DISCORD_NOTIFY_JOIN` | `true` | Notifier connexions (avec rang par ancienneté — Bronze/Argent/Or/Platine) |
| `DISCORD_NOTIFY_LEAVE` | `true` | Notifier déconnexions |
| `DISCORD_NOTIFY_MOD_UPLOAD` | `true` | Notifier uploads de mods |
| `DISCORD_NOTIFY_MAP_CHANGE` | `true` | Notifier les changements de carte active |
| `DISCORD_NOTIFY_RESTART` | `true` | Notifier redémarrages |

### Public

| Variable | Description |
|---|---|
| `SERVER_DESCRIPTION` | Description affichée sur la page publique |
| `KOFI_URL` | Lien Ko-fi affiché dans le panel |

---

## Rôles et comptes

| Rôle | Permissions |
|---|---|
| `superadmin` | Tout — gestion utilisateurs, validation de comptes, réinitialisation de mot de passe, import |
| `admin` | Mods, maps, configuration, logs, cohérence BDD, import, redémarrage serveur |
| `moderator` | Consultation uniquement — pas d'accès aux logs serveur, aucune action de mutation |

Un changement de rôle ou une suppression de compte prend effet **immédiatement**
sur les sessions déjà ouvertes (le rôle est revérifié en base à chaque requête,
pas seulement lu depuis le cookie de session) — pas besoin d'attendre l'expiration
du cookie (7 jours) ni de déconnecter l'utilisateur.

### Création de compte joueur

1. Le joueur se connecte au serveur BeamMP → enregistré automatiquement
2. Il visite le panel → **"Demander un compte"** → saisit son pseudo BeamMP exact
3. Le SuperAdmin valide la demande dans *Administration* → définit un mot de passe initial.
   Le compte est créé en rôle `moderator` par défaut (moindre privilège) ;
   promotion en `admin` via une action explicite du SuperAdmin.
4. Le joueur peut se connecter

### Mot de passe

Tout utilisateur connecté peut changer son propre mot de passe via l'icône
clé à côté du bouton de déconnexion (mot de passe actuel requis).

Un SuperAdmin peut aussi réinitialiser le mot de passe de n'importe quel
compte existant depuis *Administration → Utilisateurs* (icône clé), sans
avoir à supprimer puis recréer le compte — utile en cas de perte, ou pour
fixer un mot de passe temporaire à un compte nouvellement créé.

---

## Sécurité

- Sessions httpOnly + SameSite=Strict (pas de token en localStorage), rôle
  revérifié en base à chaque requête (pas de session périmée après un
  changement de rôle ou une suppression de compte)
- Cookie `Secure` activé via `COOKIE_SECURE=true` derrière HTTPS
- Mots de passe bcrypt coût 12 — migration transparente depuis les anciens hashes scrypt
- Uploads validés par magic bytes (signature ZIP `PK\x03\x04`)
- Conteneur non-root (UID 1000)
- Headers de sécurité via `@fastify/helmet`, CSP sans `unsafe-inline` sur les scripts
- Rate limiting par IP : `/api/auth/login` et `/api/auth/request-account`
  (5 req/min chacun), redémarrage serveur (3 req/min) — voir `TRUST_PROXY_HOPS`
  si le panel est derrière un reverse proxy, sinon le rate-limit reste basé
  sur l'IP directe
- Toutes les opérations fichier (upload, cohérence, import) sanitisent les
  noms de fichiers et vérifient que le chemin résolu reste dans le dossier attendu
- beammp-agent (redémarrage) : token dans un fichier dédié en 600 (jamais dans
  le unit systemd, lisible par défaut), lié à l'IP de la passerelle Docker du
  projet (pas `0.0.0.0` ni l'IP LAN), aucun endpoint fichier exposé au-delà
  du strict nécessaire
