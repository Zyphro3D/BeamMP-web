# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/).
`X-BeamMP-Panel-Version` (header HTTP sur chaque réponse API) reflète la
dernière entrée de ce fichier.

## [1.1.0] — 2026-08-07

Passe complète suite à deux audits indépendants (sécurité, backend, qualité,
devops, performance, UI) : correctifs de sécurité critiques, parité
fonctionnelle avec la V1, restructuration du frontend, durcissement de
l'infrastructure de redémarrage.

### Sécurité

- **Traversée de chemin** sur `POST /api/admin/i/:instanceId/consistency/fix` —
  le nom de fichier et le dossier cible venaient du body client sans
  sanitisation ; re-dérivés depuis la base de données.
- **Traversée de chemin + IDOR** sur `POST /api/i/:instanceId/mods/:id/image` —
  `id` n'était pas validé comme numérique avant de construire un chemin
  fichier, et l'écriture en base ne filtrait pas par instance.
- **Fuite de `ServerConfig.toml`** — le `GET` renvoyait le fichier entier
  sans filtre (un `AuthKey` aurait été lisible par tout compte connecté),
  alors que le `PATCH` restreignait déjà l'écriture à une whitelist.
- **Injection TOML** via retour chariot et séparateurs de ligne Unicode
  (`\r`, `\n`, `U+2028`, `U+2029`) dans les valeurs de configuration.
- **Rôle `moderator` réellement appliqué** — un nouveau `requireAdmin`
  bloque désormais `moderator` sur toutes les routes de mutation (mods,
  maps, config, logs, cohérence, import, redémarrage) ; jusqu'ici `moderator`
  avait les mêmes droits qu'`admin` malgré ce que documentait le README.
- Les comptes approuvés via **"Demander un compte"** sont créés en
  `moderator` par défaut (avant : `admin` par défaut, contraire au moindre
  privilège).
- **Fraîcheur de session** — le rôle est revérifié en base de données à
  chaque requête authentifiée au lieu d'être figé dans le JWT ; un
  changement de rôle ou une suppression de compte prend effet
  immédiatement, plus besoin d'attendre l'expiration du cookie (7 jours).
- `trustProxy` conditionnel (`TRUST_PROXY_HOPS`) au lieu de `true` en dur —
  le rate-limit de login était contournable en forgeant `X-Forwarded-For`
  tant qu'aucun reverse proxy de confiance n'écrasait l'en-tête.
- Rate limiting ajouté sur `/api/auth/request-account` et
  `POST /api/i/:instanceId/server/restart` (3 req/min).
- CSP : `unsafe-inline` retiré de `script-src` (le build ne contient aucun
  script inline ; `style-src` le garde, nécessaire pour les styles React).
- Garde symlink (`realpath`) en défense en profondeur sur les opérations
  fichier de la vérification de cohérence.
- `.env` verrouillé en `600` (était lisible par tout utilisateur du host).
- **beammp-agent** (host, hors dépôt) : le token de redémarrage vit
  maintenant dans un fichier dédié `600 root:root` au lieu du unit systemd
  (lisible par défaut par tout le monde) ; l'agent n'écoute plus que sur
  l'IP de la passerelle du réseau Docker du projet au lieu de `0.0.0.0`
  (injoignable depuis le réseau local) ; les endpoints de lecture/écriture/
  suppression de fichiers (jamais appelés par le panel) ont été retirés,
  ne restent que `/health` et `/restart`.

### Ajouté

- **Redémarrage réel du serveur** via beammp-agent (renvoyait
  systématiquement `501` auparavant).
- **Rangs Discord par ancienneté** (Bronze/Argent/Or/Platine + note sur les
  sessions anormalement courtes) dans les notifications de connexion,
  repris du bot de la V1.
- Notification Discord manquante pour le **changement de carte active**
  (`DISCORD_NOTIFY_MAP_CHANGE`).
- `PATCH /api/admin/users/:id/password` — réinitialisation du mot de passe
  d'un compte existant (jusqu'ici : suppression puis recréation obligatoire).
- `Tags` et `Debug` éditables dans la configuration du serveur (whitelist
  étendue à 8 clés).
- `scripts/backup-postgres.sh` — sauvegarde PostgreSQL (aucune n'existait
  jusque-là), cron planifié, section README dédiée.
- Variables d'environnement : `TRUST_PROXY_HOPS`, `DISCORD_NOTIFY_MAP_CHANGE`,
  `BEAMMP_AGENT_URL`/`_TOKEN`/`_SERVICE`, `PORT`/`IMAGES_PATH`/`INSTANCE_NAME`
  (avancé) — toutes documentées dans `.env.example` et le README.

### Modifié

- **Frontend restructuré** : `Dashboard.tsx` (1660 lignes, toute
  l'interface d'administration) éclaté en `pages/dashboard/*.tsx` par
  section, `components/{mods,admin}/*.tsx`, `hooks/useModUpload.ts`,
  `lib/{format,sortMods}.ts`.
- `known_players` scopé par instance (`instance_id` + contrainte unique) —
  les statistiques d'un même pseudo BeamMP ne s'agrègent plus entre
  instances en mode multi-instance.
- Classement "top players" trié par `total_seconds` (temps de jeu réel) au
  lieu de `last_seen` — un joueur historique n'est plus éclipsé par des
  connexions récentes plus courtes.
- `GET /api/admin/players` plafonné à 200 lignes + index dédié.
- `fileService.listDir()` passé en async (`fs.promises.readdir`) — le scan
  de cohérence tourne réellement en parallèle sur ses 4 dossiers au lieu de
  bloquer l'event-loop en série.
- `GET /logs` passé en lecture async — était synchrone, bloquant pour
  toutes les requêtes en cours à chaque poll de 5 s pendant que l'onglet
  Config est ouvert.
- `getServerStatus()` déduplique les appels concurrents en vol par
  instance (effet troupeau évité sur plusieurs viewers SSE simultanés).
- Upload par lot plafonné à 2 en concurrence (traitement d'image CPU-bound).
- `scan-import` : une seule requête préchargée au lieu d'une par fichier
  zip scanné.
- Nettoyage de `/opt/app-docker` : copie intégrale et redondante de la V1
  supprimée ; `CONTRIBUTING.md`/`SECURITY.md` déplacés dans le dépôt qu'ils
  documentent.

### Corrigé

- Upload de mod : le fichier était écrasé sur disque avant l'écriture en
  base, sans gestion de conflit — corruption silencieuse possible sur une
  collision de nom sanitizé.
- `POST /mods/:id/toggle` acceptait à tort une carte, créant des
  incohérences (0 ou 2+ cartes actives) que la vérification de cohérence
  est censée détecter.
- `PATCH` de configuration silencieusement sans effet si la clé était
  absente du fichier — répond maintenant en ajoutant la ligne.
- Approbation de demande de compte marquée "approuvée" même quand un
  conflit de nom d'utilisateur annulait silencieusement la création.
- Cascade de statut serveur (API publique → API locale → logs) qui
  affichait "hors ligne" trop tôt sur une simple absence transitoire de
  l'API publique.
- `?lines=abc` sur les logs renvoyait le fichier entier au lieu de la
  valeur par défaut (100).
- Healthcheck Docker en échec permanent (`localhost` résolu en IPv6 par
  wget côté image alpine, alors que Fastify n'écoute qu'en IPv4).
- Titre de section "Import" affichant "Admin" (case manquante dans la
  ternaire du header après l'éclatement de `Dashboard.tsx`).
- `Avatar` et `formatUptime` dupliqués avec un rendu divergent dans
  `Sidebar.tsx` (non touché par la restructuration initiale).
- Bouton de redémarrage de `SectionConfig` toujours cliquable sans
  vérifier si l'agent est configuré, erreur avalée silencieusement —
  remonté en prop unique depuis `Dashboard.tsx`, erreur affichée à
  l'utilisateur.
- Contrastes en mode clair sur plusieurs badges/couleurs de statut sans
  variante `dark:`.
- `aria-label` manquants sur `Modal`, `ErrorBanner`, `Toggle` ;
  `htmlFor`/`id` manquants sur plusieurs formulaires.
- `scripts/backup-postgres.sh` pouvait "réussir" silencieusement sur un
  dump vide (pipe direct vers `gzip`, qui masque l'échec de `pg_dump`) et
  purger ensuite les sauvegardes valides existantes — détection explicite
  ajoutée avant toute écriture ou purge.
- Entrée cron de sauvegarde avec chemin relatif (cron ne démarre pas dans
  le dossier du projet) et destination de log `/var/log/` non accessible
  en écriture pour un utilisateur non-root.
- **Détection du type "véhicule" au Scan & Import** — un zip contenant le
  moindre fichier sous `vehicles/` (y compris `vehicles/common/`, dossier
  de pièces partagées entre véhicules) était classé `vehicle`, ce qui
  classait aussi bien des packs de jantes/pneus/moteurs que des packs de
  configuration comme des véhicules sélectionnables. Un zip n'est
  désormais classé `vehicle` que s'il contient un `vehicles/<nom>/info.json`
  propre à ce dossier (signal fiable qu'il définit un véhicule, par
  opposition à `info_<variante>.json` qui ne fait qu'ajouter des
  configurations à un véhicule existant). 30 des 199 lignes `mods` déjà
  classées `vehicle` en base ont été corrigées rétroactivement (script
  ponctuel, pas de migration automatique — le heuristique ne s'applique
  qu'aux futurs imports).

## [1.0.0] — antérieur

Version de référence avant cette passe : réécriture V2 du panel (Fastify +
PostgreSQL + React), multi-instance, gestion des mods/maps/config/logs,
migration depuis la V1 (MariaDB/PHP). Historique détaillé non tenu avant
ce fichier.
