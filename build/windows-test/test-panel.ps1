# Test réel du paquet Windows de BeamMP Panel, sur le compte limité « claude-test ».
# Décompresse, lance par le vrai lanceur, passe l'assistant (télécharge BeamMP-Server.exe), vérifie, arrête.
$ErrorActionPreference = 'Stop'
$home2 = $env:USERPROFILE
$pkgRoot = Join-Path $home2 'bmp-test'
$pkg = Join-Path $pkgRoot 'BeamMP Panel'
$srv = Join-Path $home2 'BeamMP-Server'
$data = Join-Path $env:APPDATA 'BeamMP Panel'
$base = 'http://127.0.0.1:3000'
function OK($m) { Write-Output "OK      $m" }
function KO($m) { Write-Output "ERREUR  $m" }
function Api($method, $path, $body, $session) {
  $p = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true; TimeoutSec = 120 }
  if ($body) { $p.Body = ($body | ConvertTo-Json); $p.ContentType = 'application/json' }
  if ($session) { $p.WebSession = $session }
  return Invoke-WebRequest @p
}

Get-Process pythonw,python,BeamMP-Server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $pkgRoot, $srv, $data -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $pkgRoot | Out-Null
$t0 = Get-Date
& tar.exe -xf (Join-Path $home2 'Downloads\BeamMP-Panel-win64.zip') -C $pkgRoot
OK ('décompression en {0:N1} s' -f ((Get-Date) - $t0).TotalSeconds)
if (Test-Path (Join-Path $pkg 'Lancer BeamMP Panel.bat')) { OK 'paquet décompressé' } else { KO 'paquet incomplet'; exit 1 }

# lancement comme un utilisateur (double-clic), sans ouvrir de navigateur
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '_start.cmd' -WorkingDirectory $pkg -WindowStyle Hidden
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep 1
  try { $port = (Get-Content (Join-Path $data 'settings.json') -Raw | ConvertFrom-Json).port } catch { $port = $null }
  if (-not $port) { $port = 3000 }
  $script:base = "http://127.0.0.1:$port"
  try { $r = Api GET '/api/setup'; $up = $true; break } catch {}
}
OK "port utilisé : $port"
if (-not $up) { KO 'le panel ne répond pas'; Get-Content (Join-Path $data 'panel.log') -Tail 30 -ErrorAction SilentlyContinue; exit 1 }
$st = $r.Content | ConvertFrom-Json
OK ("panel démarré en {0} s, version {1}" -f $i, $r.Headers['X-BeamMP-Panel-Version'])
if ($st.appMode -and $st.needed) { OK "assistant demandé (dossier proposé : $($st.serverDir))" } else { KO "assistant non demandé : $($r.Content)" }
$page = Invoke-WebRequest -Uri "$base/setup" -UseBasicParsing
if ($page.Content -match '<div id="root">') { OK 'page /setup servie' } else { KO 'page /setup absente' }

# assistant : téléchargement du vrai BeamMP-Server.exe
$key = '00000000-0000-0000-0000-000000000000'
try {
  $r = Api POST '/api/setup' @{ serverDir = $srv; downloadServer = $true; serverName = 'Test claude'; authKey = $key; username = 'admin'; password = 'motdepasse-test' }
  OK "assistant terminé : $($r.Content)"
} catch { KO "assistant : $($_.ErrorDetails.Message) $_"; exit 1 }
if (Test-Path (Join-Path $srv 'BeamMP-Server.exe')) { OK ('BeamMP-Server.exe téléchargé ({0:N1} Mo)' -f ((Get-Item (Join-Path $srv 'BeamMP-Server.exe')).Length / 1MB)) } else { KO 'BeamMP-Server.exe absent' }

$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Api POST '/api/auth/login' @{ username = 'admin'; password = 'motdepasse-test' } $s | Out-Null
OK 'connexion admin'
Start-Sleep 12
$state = (Api GET '/api/i/default/server/state' $null $s).Content | ConvertFrom-Json
if ($state.running) { OK "BeamMP-Server en marche (pid $($state.pid))" } else { KO "BeamMP-Server arrêté : $($state.error)" }
$log = Join-Path $srv 'Server.log'
if (Test-Path $log) { OK 'Server.log écrit'; Get-Content $log -Tail 6 | ForEach-Object { Write-Output "        | $_" } } else { KO 'pas de Server.log' }
$status = (Api GET '/api/i/default/status').Content | ConvertFrom-Json
OK ("statut : online={0} source={1} maxPlayers={2} nom={3}" -f $status.online, $status.source, $status.maxPlayers, $status.serverName)
$alerts = (Api GET '/api/i/default/alerts' $null $s).Content
OK "alertes : $alerts"

$pid1 = $state.pid
Api POST '/api/i/default/server/restart' $null $s | Out-Null
Start-Sleep 4
$state2 = (Api GET '/api/i/default/server/state' $null $s).Content | ConvertFrom-Json
if ($state2.running -and $state2.pid -ne $pid1) { OK "redémarrage (nouveau pid $($state2.pid))" } else { KO "redémarrage : $($state2 | ConvertTo-Json -Compress)" }
$upd = (Api GET '/api/i/default/server/update-check' $null $s).Content
OK "mise à jour serveur : $upd"
$pupd = (Api POST '/api/panel/update/check' $null $s).Content
OK "mise à jour panel : $pupd"
$cfg = (Api GET '/api/i/default/config' $null $s).Content
OK "config lue : $cfg"
$cat = (Api GET '/api/i/default/catalog').Content
OK "catalogue : $cat"

# deuxième lancement : doit seulement rendre la main
$t0 = Get-Date
Start-Process -FilePath (Join-Path $pkg 'python\python.exe') -ArgumentList '-X', 'utf8', '-m', 'beammp_panel' -WorkingDirectory $pkg -WindowStyle Hidden -Wait
OK ('deuxième lancement rendu en {0:N1} s (panel déjà actif)' -f ((Get-Date) - $t0).TotalSeconds)

# arrêt : le serveur BeamMP doit s'arrêter avec le panel
& cmd /c (Join-Path $pkg 'Arreter BeamMP Panel.bat') | Out-Null
Start-Sleep 3
$left = Get-Process BeamMP-Server -ErrorAction SilentlyContinue
if ($left) { KO "BeamMP-Server encore en marche après l'arrêt du panel (pid $($left.Id))" } else { OK 'BeamMP-Server arrêté avec le panel' }
try { Api GET '/api/info' | Out-Null; KO 'le panel répond encore' } catch { OK 'panel arrêté' }
Write-Output '--- panel.log (fin) ---'
Get-Content (Join-Path $data 'panel.log') -Tail 12 -ErrorAction SilentlyContinue
