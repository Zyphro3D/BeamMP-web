# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/).
`X-BeamMP-Panel-Version` (header HTTP sur chaque réponse API) reflète la
dernière entrée de ce fichier.

## [Non publié]

Corrections suite à un audit complet (sécurité, backend, qualité, devops,
performance, UI) sur le nouveau périmètre de la 1.2.0 — essentiellement
`scripts/migrate-v1-to-v2.mjs` et les nouveaux boutons d'image sur les cartes.

### Ajouté

- **Changement de mot de passe en libre-service** (`PATCH /api/auth/password`,
  icône clé à côté de la déconnexion) — jusqu'ici seul un SuperAdmin pouvait
  réinitialiser le mot de passe d'un compte via *Administration*, aucun
  utilisateur ne pouvait changer le sien une fois connecté.
- **Mise à jour du serveur BeamMP depuis le panel** (*Configuration*, sous le
  bouton de redémarrage) — télécharge et installe la dernière release
  officielle depuis GitHub via beammp-agent, vérifie son sha256 avant toute
  installation, sauvegarde le binaire précédent. Nécessite `BEAMMP_BINARY_PATH`
  côté agent et `BEAMMP_AGENT_ASSET` côté panel (les deux optionnels — sans
  eux, redémarrage seul reste disponible comme avant).
- **Détection automatique des erreurs critiques dans `Server.log`** (ex.
  `Backend REFUSED the auth key`) avec bannière d'alerte visible depuis
  n'importe quelle section — jusqu'ici il fallait lire le log à la main pour
  s'apercevoir qu'une AuthKey invalide rendait le serveur invisible dans la
  liste BeamMP officielle. Pattern repris du code source de BeamMP-Server
  (`THeartbeatThread.cpp`) pour rester exact et stable.
- **Configs pré-établies** (nouvelle section *Configs*) — bascule d'un
  scénario serveur à l'autre (tel jeu de mods/véhicules + telle carte) en un
  clic au lieu de cocher chaque élément à la main : active exactement ce que
  décrit la config, désactive le reste, change de carte, redémarre le
  serveur. Un mod/véhicule supprimé depuis la sauvegarde d'une config est
  ignoré à l'application plutôt que de la rendre inutilisable. Nouvelle table
  `config_presets` ; logique de bascule mod/carte extraite de
  `POST /mods/:id/toggle` et `POST /maps/activate` vers `lib/modState.ts`
  pour être réutilisée sans duplication.
- **`scripts/migrate-v1-to-v2.mjs` reprend aussi les cartes officielles
  BeamNG** (`map_officielle` en V1) — un concept que le schéma V2 prévoyait
  déjà (`is_official`, convention `__official__:<id>`) mais qu'aucun chemin
  de création ne peuplait jamais ; 14 cartes du jeu de base totalement
  absentes du catalogue V2 avant ce correctif, créées inactives.

### Corrigé

- **Panneau de logs qui arrachait la lecture en cours** (*Configuration*) —
  le défilement automatique vers le bas se déclenchait à chaque poll (5s),
  y compris quand l'utilisateur avait remonté pour lire un log plus ancien.
  Ne recolle en bas que si l'utilisateur y était déjà.
- **Carte active mal identifiée** — `ServerConfig.toml` pointait vers
  `Black_Hills_Battle` (le mod carte `Black_Hills_Battle_Ultra_4.zip`, déjà
  en base mais jamais marqué actif ni lié par `map_id`), pendant que le
  dashboard affichait "Aucune carte active" faute de correspondance.

### Corrigé (données)

- **Comptes admin V1 non migrés** — `AutoGamingPassion` et `Mickey1978`
  (rôle `Admin` en V1, en plus de `zyphro` en SuperAdmin, déjà présent) ont
  été recréés côté V2 avec le même rôle (`admin`) et un mot de passe
  temporaire à faire changer via la nouvelle fonctionnalité ci-dessus —
  volontairement non repris par `scripts/migrate-v1-to-v2.mjs` (schéma de
  mot de passe différent), documenté dans le README, mais jamais recréé
  manuellement avant ce jour.
- **14 cartes officielles BeamNG récupérées depuis la V1** via le nouveau
  support de `migrate-v1-to-v2.mjs` (voir ci-dessus) : Automation Test Track,
  Centre de formation ETK, Circuit Hirochi, Côte Est/Ouest USA, Derby,
  Gridmap v2, Ile Jungle Rock, Ile Small USA, Italie, Johnson Valley, Petite
  grille, Site industriel, Utah USA.
- **Serveur BeamMP mis à jour** de v3.9.0 à v3.9.3 (durcissements inclus :
  limitation par IP, validation de la longueur des messages de chat, parsing
  durci contre les paquets véhicule malformés).

### Sécurité

- **Traversée de chemin potentielle dans `scripts/migrate-v1-to-v2.mjs`** —
  les noms de fichier image/description venant de la base V1 n'étaient pas
  validés avant d'être utilisés dans un chemin de lecture local et dans la
  destination d'un `docker compose cp` ; une valeur contenant `../` aurait pu
  faire sortir la lecture de `DATA/images`/`DATA/descriptions`, ou faire
  écrire hors de `/app/images` dans le conteneur. Corrigé avec le même
  garde-fou que `backend/src/routes/admin.ts` (`safeBasename` : rejette toute
  valeur contenant un séparateur de chemin plutôt que de la nettoyer).
- **Construction SQL par concaténation de chaînes** dans le script de
  migration (`sqlEscape`) — non exploitable dans la configuration Docker
  actuelle (PostgreSQL 16, `standard_conforming_strings=on` par défaut), mais
  seul point du projet à ne pas utiliser de requêtes paramétrées. Remplacé :
  les écritures passent désormais par `scripts/migrate-runner.mjs`, exécuté
  dans le conteneur `app` via le module `pg` déjà présent, avec des requêtes
  `$1, $2…` et aucune valeur jamais insérée dans du texte SQL.
- **Mot de passe MariaDB V1 passé en argument `mysql -p<mot de passe>`** —
  visible par tout utilisateur local via `ps`/`/proc/<pid>/cmdline` le temps
  de l'exécution. Remplacé par un fichier `--defaults-extra-file` temporaire
  en `600`, supprimé juste après usage.
- **Limite de taille absente sur l'extraction de preview** (`lib/zipPreview.ts`)
  — un zip pouvait déclarer une entrée `preview.jpg` fortement compressée qui,
  une fois décompressée en mémoire par `sharp`, pouvait saturer le process
  Fastify partagé par toutes les instances (déni de service). Rejette
  désormais toute entrée de plus de 20 Mio non compressés avant décompression.

### Corrigé

- **Application SQL non atomique en cas d'échec partiel** — `psql -f` sans
  `ON_ERROR_STOP` continuait après une ligne en erreur et retournait un code
  de sortie 0 : une migration pouvait être appliquée à moitié tout en
  s'affichant comme réussie. Chaque lot d'opérations s'exécute désormais dans
  une transaction unique (tout ou rien), et un échec fait maintenant échouer
  le script de façon visible.
- **Import joueurs non rejouable sans risque** — la fusion des statistiques
  est additive par nature (périodes V1/V2 disjointes) ; relancer l'étape pour
  le même site V1 aurait doublé les compteurs déjà migrés. Un garde-fou local
  (`scripts/.migrate-v1-to-v2.state.json`, propre à la machine) bloque
  désormais une seconde exécution par site V1 + instance sauf `--force-players`
  explicite.
- **Identifiants PostgreSQL V2 codés en dur** (`beammp`/`beammp`) dans le
  script de migration — cassait si les identifiants par défaut avaient été
  changés (recommandé en production). Lus depuis les variables d'environnement
  du conteneur `postgres` lui-même.
- **Fichier temporaire du script de migration non nettoyé en cas d'échec** —
  le nettoyage côté conteneur ne s'exécutait qu'après un `psql -f` réussi ;
  englobé dans un `finally` pour s'exécuter dans tous les cas.
- **Collision de nom d'image entre instances** — le nom de fichier extrait
  automatiquement d'un zip (`<nom>.webp`) ne dépendait que du nom du mod, pas
  de l'instance, alors que le dossier d'images est un volume partagé entre
  toutes les instances : deux instances avec un mod de même nom de fichier
  pouvaient silencieusement écraser l'image l'une de l'autre. Préfixé par
  l'identifiant d'instance.
- **Upload d'image échouant silencieusement** — `ModCard`/`MapCard`
  n'avaient aucune gestion d'erreur sur l'upload d'image (contrairement au
  reste de l'app) : un échec (fichier invalide, session expirée…) ne
  produisait aucun retour visible. Erreur maintenant affichée sous la carte,
  et le backend renvoie un message clair (`Fichier image invalide`) au lieu
  d'un 500 générique quand le fichier envoyé n'est pas une image valide.
- **Sections Upload/Configuration visibles pour `moderator`** dans le menu et
  au rendu direct, alors que toutes les mutations qu'elles proposent sont
  bloquées côté backend (`requireAdmin`) — un moderator pouvait ouvrir ces
  pages, remplir un formulaire, puis échouer en 403 sans comprendre pourquoi.
  Masquées comme le sont déjà Cohérence/Import pour ce rôle.
- Contraste insuffisant en mode clair sur les boutons d'action de `MapCard`
  (repris d'un défaut déjà présent sur le bouton description, maintenant
  dupliqué sur le nouveau bouton image) ; badge de rang sans `role="img"`,
  ignoré par certains lecteurs d'écran ; indicateur de chargement peu visible
  pendant l'upload d'image (remplacé par une icône animée, cohérent avec le
  reste de l'app) ; ordre des boutons harmonisé entre `ModCard`/`MapCard`.

## [1.2.0] — 2026-08-26

### Ajouté

- **Modification de l'image d'un mod/véhicule/carte après upload** — l'endpoint
  `POST /mods/:id/image` existait déjà côté backend mais n'était appelé par
  aucune interface ; une icône dédiée sur chaque carte (`ModCard`, `MapCard`)
  permet désormais de choisir sa propre image à tout moment.
- **Extraction automatique de l'image de prévisualisation sur l'upload manuel**
  (formulaire simple, hors Scan & Import) — reprend les mêmes conventions
  (`preview.jpg`, `icon.png`, texture par défaut d'un véhicule…) via un module
  partagé `lib/zipPreview.ts`, au lieu d'être limitée au Scan & Import.
- **Badge de rang** (🥉 Bronze / 🥈 Argent / 🥇 Or / 💎 Platine, par
  `connection_count`) affiché à côté de chaque joueur dans *Joueurs* — jusqu'ici
  visible uniquement dans le message Discord de connexion.
- **`scripts/migrate-v1-to-v2.mjs`** — outil de migration réutilisable pour
  quiconque passe de la V1 à la V2 : resynchronise images et descriptions,
  fusionne les statistiques joueurs depuis l'ancienne base MariaDB, signale
  les mods sans équivalent V2 à traiter via Scan & Import. Mode aperçu par
  défaut. Remplace `migrate/migrate.js` et `migrate/import.js` (présents
  depuis le tout premier commit du dépôt, mais cassés depuis le passage
  multi-instance : `ON CONFLICT` sur `beammp_username`/`filename` seuls,
  alors que la contrainte réelle est désormais `(instance_id, ...)` —
  dossier `migrate/` supprimé, remplacé par cet outil unique et testé.
- Import des **descriptions** de mods/véhicules/cartes depuis la V1
  (`DATA/descriptions/*.json`) dans `scripts/migrate-v1-to-v2.mjs` — ne
  remplit que les descriptions V2 actuellement vides (jamais d'écrasement,
  contrairement aux images), ignore les descriptions V1 auto-générées sans
  contenu réel ("Description non fournie.", "Description pour X").

### Corrigé

- **Images de tous les mods/véhicules/cartes resynchronisées avec la V1** —
  l'extraction automatique (Scan & Import comme upload manuel) tire l'image
  depuis le contenu du zip, ce qui donne parfois un résultat de moins bonne
  qualité qu'une image choisie à la main (texture technique, angle non
  représentatif…). Les 256 mods de l'instance ont été réassociés à l'image
  d'origine de la V1 (`/var/www/.../DATA/images`, ancienne base MariaDB
  `beammp_Officiel`), sur la base d'une correspondance exacte de nom de
  fichier (256/256 retrouvées) — pas seulement ceux qui n'avaient aucune
  image.
- Fichiers copiés depuis la V1 avec des permissions Unix héritées de
  l'ancien serveur web (`www-data`, non lisibles par le process Node du
  panel) — provoquait des `500` sur `/images/*` pour les fichiers concernés ;
  propriété et permissions corrigées.
- **`known_players` était vide côté V2** — la section *Joueurs* n'avait jamais
  affiché aucune donnée depuis la bascule. Les 335 joueurs de la V1
  (connexions, temps de jeu, dernière activité) ont été importés.
- **Descriptions jamais migrées depuis la V1** — 36 mods/véhicules/cartes de
  l'instance avaient un texte descriptif réel en V1 (hors placeholders
  auto-générés), perdu lors de la bascule vers la V2 ; réimportés.
- **`package.json` (backend et frontend) resté à `1.0.0`** alors que
  `PANEL_VERSION`/le changelog étaient déjà à `1.1.0` — remis en cohérence.
- **`GET /api/admin/players` exigeait `superadmin`** alors que le lien
  *Joueurs* est visible dans le menu pour tous les rôles — un `admin` ou
  `moderator` tombait sur une erreur 403 en cliquant dessus. Abaissé à
  `requireAuth`, cohérent avec le reste des données en lecture seule
  (aucune donnée sensible dans cette liste — pseudos et statistiques déjà
  publiques en jeu).

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
