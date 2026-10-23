#!/usr/bin/env bash
# Fabrique BeamMP-Panel-<version>-win64.zip : Python Windows embarqué + dépendances + le panel.
# Aucune installation chez l'utilisateur : on décompresse, on double-clique. Se lance depuis Linux (uv requis).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); OUT="$ROOT/dist"; PKG="$OUT/BeamMP Panel"; CACHE="$ROOT/build/.cache"
PYV=3.12.10
VER=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$ROOT/server/beammp_panel/__init__.py")
rm -rf "$PKG"; mkdir -p "$PKG/app" "$CACHE" "$OUT"

# 1. Python embarqué
EMBED="$CACHE/python-$PYV-embed-amd64.zip"
[ -f "$EMBED" ] || curl -fsSL -o "$EMBED" "https://www.python.org/ftp/python/$PYV/python-$PYV-embed-amd64.zip"
python3 -I -c "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$EMBED" "$PKG/python"
printf 'python312.zip\r\n.\r\n..\\app\r\n..\\site-packages\r\n' > "$PKG/python/python312._pth"

# 2. dépendances, roues Windows uniquement
uv pip install --quiet --python-platform x86_64-pc-windows-msvc --python-version 3.12 \
  --target "$PKG/site-packages" --only-binary=:all: -r "$ROOT/server/requirements.txt"
rm -rf "$PKG/site-packages/bin"

# 3. le panel + son interface
(cd "$ROOT/frontend" && npm run build >/dev/null)
cp -r "$ROOT/server/beammp_panel" "$PKG/app/beammp_panel"
rm -rf "$PKG/app/beammp_panel/static"; cp -r "$ROOT/frontend/dist" "$PKG/app/beammp_panel/static"
printf 'PUBLIC_KEY_B64 = "%s"\n' "$(tr -d '\n' < "$ROOT/build/update_public.b64")" > "$PKG/app/beammp_panel/_updkey.py"
find "$PKG" -name '__pycache__' -type d -prune -exec rm -rf {} +

# 4. lanceurs (fins de ligne Windows)
sed 's/$/\r/' "$ROOT/build/_start.cmd" > "$PKG/_start.cmd"
printf '@echo off\r\ncall "%%~dp0_start.cmd" --open\r\n' > "$PKG/Lancer BeamMP Panel.bat"
printf '@echo off\r\nchcp 65001 >nul\r\ntitle BeamMP Panel (console de secours)\r\ncd /d "%%~dp0"\r\necho Demarrage de BeamMP Panel (console de secours : affiche les erreurs)...\r\nset BMP_CONSOLE=1\r\ncall "%%~dp0_start.cmd" --open\r\necho.\r\necho BeamMP Panel est arrete. Appuyez sur une touche pour fermer.\r\npause >nul\r\n' > "$PKG/Lancer BeamMP Panel (console de secours).bat"
cat > "$PKG/Arreter BeamMP Panel.bat" <<'STOP'
@echo off
cd /d "%~dp0"
echo Arret de BeamMP Panel (le serveur BeamMP qu'il a lance s'arrete avec lui)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$r=(Get-Location).Path+'\python\'; Get-Process pythonw,python -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($r,[StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force"
echo Termine.
ping -n 3 127.0.0.1 >nul
STOP
sed -i 's/$/\r/' "$PKG/Arreter BeamMP Panel.bat"
cat > "$PKG/Debloquer si alerte Windows.bat" <<'UNBLOCK'
@echo off
chcp 65001 >nul
echo Retire le marquage "telecharge depuis Internet" des fichiers de BeamMP Panel (supprime l'alerte Windows).
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -Force | Unblock-File"
echo Termine.
pause
UNBLOCK
sed -i 's/$/\r/' "$PKG/Debloquer si alerte Windows.bat"

cat > "$PKG/LISEZ-MOI.txt" <<TXT
BeamMP Panel $VER — votre serveur BeamMP géré depuis le navigateur

1) Décompressez ce dossier où vous voulez (Documents, D:\\...). Ne le lancez pas depuis l'intérieur du zip.
   Alerte Windows ? Double-cliquez d'abord sur « Debloquer si alerte Windows.bat ».
2) Double-cliquez sur « Lancer BeamMP Panel.bat ». La page du panel s'ouvre dans votre navigateur.
   Si Windows affiche « Windows a protégé votre ordinateur » : « Informations complémentaires » puis « Exécuter quand même ».
3) Au premier lancement, un assistant demande le dossier du serveur BeamMP (il peut télécharger BeamMP-Server
   pour vous), son nom, sa clé (facultative) et votre compte administrateur. C'est tout.

Le panel démarre lui-même le serveur BeamMP, le relance s'il plante et l'arrête quand vous arrêtez le panel.
Pour tout arrêter : « Arreter BeamMP Panel.bat ». Un souci au démarrage : « Lancer BeamMP Panel (console de secours).bat »
affiche les erreurs.

MISES A JOUR : dans Configuration, « Mise à jour du panel » ; un clic, vos données sont conservées, et si la nouvelle
version ne démarre pas, l'ancienne revient toute seule. Les versions sont signées : une mise à jour falsifiée est refusée.
Le serveur BeamMP se met à jour au même endroit (« Mise à jour du serveur »).

VOS DONNEES : %APPDATA%\\BeamMP Panel (base, images, réglages, journal panel.log). Rien n'est envoyé ailleurs.
ACCES DEPUIS UN AUTRE PC : par défaut le panel n'écoute que sur ce PC (http://127.0.0.1:3000). Pour l'ouvrir au
réseau, mettez "host": "0.0.0.0" dans %APPDATA%\\BeamMP Panel\\settings.json puis relancez.
Pour désinstaller : arrêtez le panel, supprimez ce dossier (et %APPDATA%\\BeamMP Panel pour effacer les données).
TXT
sed -i 's/$/\r/' "$PKG/LISEZ-MOI.txt"

# 5. archive
ZIP="$OUT/BeamMP-Panel-$VER-win64.zip"; rm -f "$ZIP"
(cd "$OUT" && python3 -I -c "
import zipfile,os,sys
z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED,compresslevel=9)
for r,d,f in os.walk('BeamMP Panel'):
    for x in f: z.write(os.path.join(r,x))
z.close()" "$ZIP")
ls -la "$ZIP"; du -sh "$PKG"
