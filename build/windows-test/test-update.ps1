# Test de la mise à jour depuis le panel, sur le compte « claude-test » :
# phase install (3.1.9 installée + assistant), phase update (vers 3.2.0, miroir local), phase broken (3.2.1 cassée -> retour arrière).
param([string]$Phase)
$ErrorActionPreference = 'Stop'
$pkgRoot = Join-Path $env:USERPROFILE 'bmp-test'
$pkg = Join-Path $pkgRoot 'BeamMP Panel'
$srv = Join-Path $env:USERPROFILE 'BeamMP-Server'
$data = Join-Path $env:APPDATA 'BeamMP Panel'
function OK($m) { Write-Output "OK      $m" }
function KO($m) { Write-Output "ERREUR  $m" }
function Port { try { (Get-Content (Join-Path $data 'settings.json') -Raw | ConvertFrom-Json).port } catch { 3000 } }
function Api($method, $path, $body, $session) {
  $p = @{ Method = $method; Uri = ("http://127.0.0.1:{0}{1}" -f (Port), $path); UseBasicParsing = $true; TimeoutSec = 60 }
  if ($body) { $p.Body = ($body | ConvertTo-Json); $p.ContentType = 'application/json' }
  if ($session) { $p.WebSession = $session }
  Invoke-WebRequest @p
}
function WaitUp($max) { for ($i = 0; $i -lt $max; $i++) { Start-Sleep 1; try { return (Api GET '/api/info') } catch {} }; return $null }
function Launch { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '_start.cmd' -WorkingDirectory $pkg -WindowStyle Hidden }
function Login { $s = New-Object Microsoft.PowerShell.Commands.WebRequestSession; Api POST '/api/auth/login' @{ username = 'admin'; password = 'motdepasse-test' } $s | Out-Null; $s }

if ($Phase -like '*install*') {
  Get-Process pythonw,python,BeamMP-Server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $pkgRoot, $data -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $pkgRoot, $data | Out-Null
  & tar.exe -xf (Join-Path $env:USERPROFILE 'Downloads\BeamMP-Panel-win64.zip') -C $pkgRoot
  '{"update_base": "http://127.0.0.1:8765/good/"}' | Set-Content -Encoding ascii (Join-Path $data 'settings.json')
  Launch
  $r = WaitUp 40
  if (-not $r) { KO 'panel absent'; exit 1 }
  OK "installé : version $($r.Headers['X-BeamMP-Panel-Version']) sur le port $(Port)"
  Api POST '/api/setup' @{ serverDir = $srv; downloadServer = $true; authKey = '00000000-0000-0000-0000-000000000000'; username = 'admin'; password = 'motdepasse-test' } | Out-Null
  OK 'assistant passé (BeamMP-Server déjà téléchargé réutilisé)'
  Start-Sleep 25   # la version installée se confirme saine
}

foreach ($Step in ($Phase -split ',')) {
if ($Step -eq 'broken') {
  $cfg = Get-Content (Join-Path $data 'settings.json') -Raw | ConvertFrom-Json
  $cfg.update_base = 'http://127.0.0.1:8765/broken/'
  $cfg | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $data 'settings.json')
}
if ($Step -eq 'update' -or $Step -eq 'broken') {
  Write-Output "== $Step"
  $s = Login
  $before = (Api GET '/api/info').Headers['X-BeamMP-Panel-Version']
  $chk = (Api POST '/api/panel/update/check' $null $s).Content | ConvertFrom-Json
  if ($chk.phase -eq 'available') { OK "mise à jour proposée : $before -> $($chk.version)" } else { KO "pas de mise à jour proposée : $($chk | ConvertTo-Json -Compress)"; exit 1 }
  $inst = (Api POST '/api/panel/update/install' $null $s).Content
  OK "installation lancée : $inst"
  Start-Sleep 4
  $r = WaitUp 40
  if ($Step -eq 'update') {
    if ($r -and $r.Headers['X-BeamMP-Panel-Version'] -eq $chk.version) { OK "redémarré en $($chk.version)" } else { KO 'pas redémarré dans la nouvelle version'; exit 1 }
    if (Test-Path (Join-Path $pkg 'app.swapped')) { OK 'en attente de confirmation (app.swapped)' }
    Start-Sleep 25
    if (-not (Test-Path (Join-Path $pkg 'app.swapped')) -and -not (Test-Path (Join-Path $pkg 'app.old'))) { OK 'version confirmée saine (ancienne copie supprimée)' } else { KO 'confirmation absente' }
    $s = Login
    OK 'données conservées : connexion avec le même compte'
    Start-Sleep 6
    $st = (Api GET '/api/i/default/server/state' $null $s).Content | ConvertFrom-Json
    if ($st.running) { OK 'BeamMP-Server relancé après la mise à jour' } else { KO "BeamMP-Server arrêté : $($st.error)" }
  } else {
    if ($r) { KO "la version cassée répond ?! $($r.Headers['X-BeamMP-Panel-Version'])"; exit 1 }
    OK 'la version cassée ne démarre pas (attendu)'
    if (Test-Path (Join-Path $pkg 'app.swapped')) { OK 'marqueur de retour arrière présent' }
    Launch   # l'utilisateur relance : le lanceur doit revenir à la version précédente
    $r = WaitUp 40
    if ($r) { OK "retour arrière : le panel redémarre en $($r.Headers['X-BeamMP-Panel-Version'])" } else { KO 'pas de retour arrière'; Get-Content (Join-Path $data 'panel.log') -Tail 15; exit 1 }
    if (-not (Test-Path (Join-Path $pkg 'app.swapped'))) { OK 'marqueur effacé' }
    Start-Sleep 3
    $s = Login
    $again = (Api POST '/api/panel/update/check' $null $s).Content | ConvertFrom-Json
    if ($again.phase -ne 'available') { OK "version cassée plus proposée : $($again.error)" } else { KO 'la version cassée est reproposée' }
  }
}
}
if ($Phase -like '*stop*') {
  & cmd /c (Join-Path $pkg 'Arreter BeamMP Panel.bat') | Out-Null
  Start-Sleep 3
  if (Get-Process BeamMP-Server -ErrorAction SilentlyContinue) { KO 'BeamMP-Server encore en marche' } else { OK 'BeamMP-Server arrêté avec le panel' }
  try { Api GET '/api/info' | Out-Null; KO 'panel encore actif' } catch { OK 'panel arrêté' }
}
