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
8. [Mise à jour](#mise-à-jour)
9. [Sauvegarde](#sauvegarde)
10. [Migration depuis la V1 (MariaDB)](#migration-depuis-la-v1-mariadb)
11. [Variables d'environnement](#variables-denvironnement)
12. [Rôles et comptes](#rôles-et-comptes)

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

INSTANCE_EVENT_NAME=Serveur Évènement
INSTANCE_EVENT_SERVER_IP=1.2.3.4
INSTANCE_EVENT_SERVER_PORT=30815
INSTANCE_EVENT_BEAMMP_RESOURCES_PATH=/beammp/event/resources
INSTANCE_EVENT_BEAMMP_LOG_PATH=/beammp/event/server.log
INSTANCE_EVENT_BEAMMP_CONFIG_PATH=/beammp/event/ServerConfig.toml
```

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

## Mise à jour

```bash
git pull
docker compose up -d --build
```

Les données PostgreSQL sont conservées dans le volume `postgres_data`.
Les migrations de schéma s'appliquent automatiquement au démarrage.

---

## Sauvegarde

Le volume `postgres_data` est la seule copie des comptes, joueurs connus, mods et
historique — sans sauvegarde, sa perte (erreur `docker volume rm`, disque
corrompu, migration de machine) est irréversible.

```bash
./scripts/backup-postgres.sh            # dump vers ./backups/, gardé 14 jours
./scripts/backup-postgres.sh /mnt/nas    # ou un dossier externe au host Docker
```

À planifier via cron sur l'hôte (pas dans le conteneur) :

```cron
0 3 * * * cd /opt/app-docker/beammp-panel && ./scripts/backup-postgres.sh >> /var/log/beammp-panel-backup.log 2>&1
```

Restauration :

```bash
gunzip -c backups/beammp-panel-20260101-030000.sql.gz | docker compose exec -T postgres psql -U beammp beammp
```

> Testez périodiquement une restauration réelle — une sauvegarde jamais restaurée n'est qu'une hypothèse.

---

## Migration depuis la V1 (MariaDB)

### Méthode 1 — Via dump SQL (recommandée)

**1. Exporter depuis MariaDB** (sur la machine BeamMP) :

```bash
mysqldump -u <user> -p beammp_db beammp_Officiel users beammp_users_Officiel > migrate/dump.sql
```

**2. Lancer la migration** en copiant le dossier dans le container :

```bash
docker cp migrate/ beammp-panel-app-1:/tmp/migrate
docker exec -it beammp-panel-app-1 sh -c "cd /tmp/migrate && npm install && node migrate.js"
```

### Méthode 2 — Via export TSV (alternative)

Si MariaDB est inaccessible directement depuis la machine Docker :

**1. Sur la machine BeamMP**, exporter en TSV :

```bash
# Mods
mysql -u <user> -p --batch --silent beammp_db -e \
  "SELECT nom, description, type, archive, image, id_map, map_active, mod_actif, date FROM beammp_Officiel" \
  > migrate/mods.tsv

# Joueurs
mysql -u <user> -p --batch --silent beammp_db -e \
  "SELECT username, connection_count, last_connect, last_disconnect, total_time FROM beammp_users_Officiel" \
  > migrate/players.tsv
```

**2. Copier les fichiers TSV** dans le dossier `migrate/` sur la machine Docker.

**3. Lancer l'import :**

```bash
docker cp migrate/ beammp-panel-app-1:/tmp/migrate
docker exec -it beammp-panel-app-1 sh -c "cd /tmp/migrate && npm install && node import.js"
```

### Ce qui est migré

| Source (MariaDB) | Destination (PostgreSQL) | Notes |
|---|---|---|
| `users` | `users` | Rôles conservés — **mots de passe non migrés** |
| `beammp_<instance>` | `mods` | Mods, maps, véhicules |
| `beammp_users_<instance>` | `known_players` | Historique joueurs |

Après migration : réinitialiser les mots de passe via *Administration → Utilisateurs*.

> Si l'`instance_id` inséré ne correspond pas à `default`, corriger avec :
> ```sql
> UPDATE mods SET instance_id = 'default' WHERE instance_id != 'default';
> ```

---

## Variables d'environnement

### Application

| Variable | Défaut | Obligatoire | Description |
|---|---|---|---|
| `APP_PORT` | `3000` | | Port d'écoute du panel |
| `JWT_SECRET` | — | **Oui** | Clé secrète JWT — min 32 chars (`openssl rand -hex 32`) |
| `COOKIE_SECURE` | `false` | | Mettre `true` derrière un reverse proxy HTTPS |
| `ALLOWED_ORIGIN` | — | | URL du panel pour CORS si domaine différent |
| `SUPERADMIN_USERNAME` | — | | Login du superadmin (premier démarrage uniquement) |
| `SUPERADMIN_PASSWORD` | — | | Mot de passe min 8 chars (premier démarrage uniquement) |

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

### Discord (optionnel)

| Variable | Défaut | Description |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | — | Webhook global (fallback) |
| `DISCORD_WEBHOOK_RESTART` | — | Webhook redémarrages |
| `DISCORD_WEBHOOK_PLAYERS` | — | Webhook connexions joueurs |
| `DISCORD_WEBHOOK_MODS` | — | Webhook uploads mods |
| `DISCORD_SERVER_URL` | — | Lien invitation Discord dans le panel |
| `DISCORD_NOTIFY_JOIN` | `true` | Notifier connexions |
| `DISCORD_NOTIFY_LEAVE` | `true` | Notifier déconnexions |
| `DISCORD_NOTIFY_MOD_UPLOAD` | `true` | Notifier uploads |
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
| `superadmin` | Tout — gestion utilisateurs, validation de comptes, import |
| `admin` | Mods, maps, configuration, logs, cohérence BDD, import |
| `moderator` | Consultation uniquement |

### Création de compte joueur

1. Le joueur se connecte au serveur BeamMP → enregistré automatiquement
2. Il visite le panel → **"Demander un compte"** → saisit son pseudo BeamMP exact
3. Le SuperAdmin valide la demande dans *Administration* → définit un mot de passe initial
4. Le joueur peut se connecter

---

## Sécurité

- Sessions httpOnly + SameSite=Strict (pas de token en localStorage)
- Cookie `Secure` activé via `COOKIE_SECURE=true` derrière HTTPS
- Mots de passe bcrypt coût 12 — migration transparente depuis les anciens hashes scrypt
- Uploads validés par magic bytes (signature ZIP `PK\x03\x04`)
- Conteneur non-root (UID 1000)
- Headers de sécurité via `@fastify/helmet`
- Rate limiting sur `/api/auth/login` (5 req/min par IP)
