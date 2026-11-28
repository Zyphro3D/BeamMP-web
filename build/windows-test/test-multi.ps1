# Banc Windows de la 3.5.0 : 3.4.0 installée avec deux mods -> MAJ par le bouton -> bibliothèque (liens durs)
# -> 2e serveur -> mod partagé -> redémarrage du panel -> retrait + archive -> arrêt. Tout dans UNE session SSH.
# À côté du script : BeamMP-Panel-win64.zip (3.4.0, clé de TEST), zyphro_test_mod.zip (lua/…) et
# zyphro_test_car.zip (vehicles/…). Miroir de la 3.5.0 signée par la même clé servi sur 127.0.0.1:8765/good/
# (tools/release.py --key <clé de test> --base http://127.0.0.1:8765/good/, ssh -R 8765:…).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgRoot = Join-Path $env:USERPROFILE 'bmp-test'
$pkg = Join-Path $pkgRoot 'BeamMP Panel'
$srv = Join-Path $env:USERPROFILE 'BeamMP-Server'
$data = Join-Path $env:APPDATA 'BeamMP Panel'
$lib = Join-Path $data 'bibliotheque'
$script:ko = 0
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Say($m) { [Console]::Out.WriteLine($m) }
function OK($m) { Say "OK      $m" }
function KO($m) { $script:ko++; Say "ERREUR  $m" }
function Port { $p = $null; try { $p = (Get-Content (Join-Path $data 'settings.json') -Raw | ConvertFrom-Json).port } catch {}; if ($p) { $p } else { 3000 } }
function Url($path) { "http://127.0.0.1:{0}{1}" -f (Port), $path }
function Api($method, $path, $body, $session) {
  $p = @{ Method = $method; Uri = (Url $path); UseBasicParsing = $true; TimeoutSec = 90 }
  if ($null -ne $body) { $p.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress)); $p.ContentType = 'application/json; charset=utf-8' }
  if ($session) { $p.WebSession = $session }
  Invoke-WebRequest @p
}
function J($method, $path, $body, $session) { $o = (Api $method $path $body $session).Content | ConvertFrom-Json; $o }
function Try-J($method, $path, $body, $session) {
  try { return @{ ok = $true; data = (J $method $path $body $session) } }
  catch { $t = ''; try { $t = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}; return @{ ok = $false; err = "$($_.Exception.Message) $t" } }
}
function WaitUp($max) { for ($i = 0; $i -lt $max; $i++) { Start-Sleep 1; try { return (Api GET '/api/info') } catch {} }; return $null }
function Launch { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '_start.cmd' -WorkingDirectory $pkg -WindowStyle Hidden }
function Login { $s = New-Object Microsoft.PowerShell.Commands.WebRequestSession; Api POST '/api/auth/login' @{ username = 'admin'; password = 'motdepasse-test' } $s | Out-Null; $s }
function Upload($s, $inst, $file, $name, $type) {
  $c = ($s.Cookies.GetCookies((Url '/')) | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '; '
  $out = & curl.exe -s -w "`n%{http_code}" -H "Cookie: $c" -F "file=@$file" --form-string "name=$name" --form-string "type=$type" (Url "/api/i/$inst/mods/upload")
  $code = ($out | Select-Object -Last 1); $body = ($out | Select-Object -SkipLast 1) -join "`n"
  if ($code -match '^20') { OK "envoi de $name sur $inst ($code)"; return ($body | ConvertFrom-Json) } else { KO "envoi de $name sur $inst : $code $body"; return $null }
}
function Links($f) { if (-not (Test-Path $f)) { return 0 }; @(& fsutil.exe hardlink list $f 2>$null | Where-Object { $_ }).Count }
function SameFile($a, $b) {
  $py = Join-Path $pkg 'python\python.exe'
  (& $py -I -c "import os,sys; print(os.path.samefile(sys.argv[1], sys.argv[2]))" $a $b 2>&1) -join ''
}
function Servers { @(Get-Process BeamMP-Server -ErrorAction SilentlyContinue).Count }
function Mods($s, $inst) { @(J GET "/api/i/$inst/mods" $null $s) }
function State($s, $inst) { J GET "/api/i/$inst/server/state" $null $s }
function Tail { Say '--- panel.log (fin)'; Get-Content (Join-Path $data 'panel.log') -Tail 25 -ErrorAction SilentlyContinue }

# ── 1. installation 3.4.0 ─────────────────────────────────────
Say '== installation 3.4.0'
Get-Process pythonw,python,BeamMP-Server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $pkgRoot, $data -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $pkgRoot, $data | Out-Null
& tar.exe -xf (Join-Path $here 'BeamMP-Panel-win64.zip') -C $pkgRoot
'{"update_base": "http://127.0.0.1:8765/good/"}' | Set-Content -Encoding ascii (Join-Path $data 'settings.json')
Launch
$r = WaitUp 60
if (-not $r) { KO 'panel absent'; Tail; exit 1 }
OK "installé : version $($r.Headers['X-BeamMP-Panel-Version']) sur le port $(Port)"
$res = Try-J POST '/api/setup' @{ serverDir = $srv; downloadServer = $true; authKey = '00000000-0000-0000-0000-000000000000'; username = 'admin'; password = 'motdepasse-test' }
if ($res.ok) { OK 'assistant passé' } else { KO "assistant : $($res.err)"; Tail; exit 1 }
Start-Sleep 25
$s = Login
$m1 = Upload $s 'default' (Join-Path $here 'zyphro_test_mod.zip') 'Mod de test' 'mod'
$m2 = Upload $s 'default' (Join-Path $here 'zyphro_test_car.zip') 'Voiture de test' 'vehicle'
$car = Mods $s 'default' | Where-Object { $_.filename -eq 'zyphro_test_car.zip' }
Api POST "/api/i/default/mods/$($car.id)/toggle" $null $s | Out-Null
$client = Join-Path $srv 'Resources\Client'
if ((Test-Path "$client\zyphro_test_mod.zip") -and (Test-Path "$srv\Resources\inactive_mod\zyphro_test_car.zip")) { OK '3.4.0 : mod actif dans Client\, voiture rangée dans inactive_mod\' } else { KO '3.4.0 : fichiers pas où prévu'; Get-ChildItem -Recurse "$srv\Resources" | Select-Object FullName }

# ── 2. mise à jour par le bouton ──────────────────────────────
Say '== mise à jour'
$chk = J POST '/api/panel/update/check' $null $s
if ($chk.phase -eq 'available') { OK "proposée : $($r.Headers['X-BeamMP-Panel-Version']) -> $($chk.version)" } else { KO "pas proposée : $($chk | ConvertTo-Json -Compress)"; exit 1 }
OK "installation lancée : $((Api POST '/api/panel/update/install' $null $s).Content)"
Start-Sleep 5
$r = WaitUp 90
if ($r -and $r.Headers['X-BeamMP-Panel-Version'] -eq '3.5.0') { OK 'redémarré en 3.5.0' } else { KO 'pas en 3.5.0'; Tail; exit 1 }
Start-Sleep 30
if (-not (Test-Path (Join-Path $pkg 'app.swapped')) -and -not (Test-Path (Join-Path $pkg 'app.old'))) { OK 'version confirmée saine' } else { KO 'confirmation absente' }
$s = Login
$st = State $s 'default'
if ($st.running) { OK 'serveur 1 relancé' } else { KO "serveur 1 arrêté : $($st.error)" }

# ── 3. migration vers la bibliothèque ─────────────────────────
Say '== bibliothèque'
$l = @((J GET '/api/library' $null $s).items)
OK "bibliothèque : $(($l | ForEach-Object { $_.filename }) -join ', ')"
if ((Test-Path "$lib\zyphro_test_mod.zip") -and (Test-Path "$lib\zyphro_test_car.zip")) { OK 'les deux zips rangés dans la bibliothèque' } else { KO 'zips absents de la bibliothèque' }
if ((SameFile "$client\zyphro_test_mod.zip" "$lib\zyphro_test_mod.zip") -eq 'True') { OK "mod actif = lien dur ($(Links "$lib\zyphro_test_mod.zip") noms)" } else { KO "mod actif pas lié : $(SameFile "$client\zyphro_test_mod.zip" "$lib\zyphro_test_mod.zip")" }
if (-not (Test-Path "$srv\Resources\inactive_mod\zyphro_test_car.zip") -and -not (Test-Path "$client\zyphro_test_car.zip")) { OK 'voiture désactivée : ni dans Client\ ni dans inactive_mod\' } else { KO 'voiture encore chez le serveur 1' }

# ── 4. 2e serveur ─────────────────────────────────────────────
Say '== ajout d''un serveur'
$list = J GET '/api/admin/servers' $null $s
$p1 = ($list.servers | Where-Object { $_.id -eq 'default' }).port
$cfgPort = (Select-String -Path "$srv\ServerConfig.toml" -Pattern '^Port\s*=\s*(\d+)').Matches[0].Groups[1].Value
if ($p1 -eq [int]$cfgPort -and $list.nextPort -ne $p1) { OK "serveur 1 sur $p1 (lu dans son ServerConfig.toml), port proposé $($list.nextPort)" } else { KO "ports : serveur 1=$p1 (fichier $cfgPort), proposé $($list.nextPort)" }
if ($list.canAdd) { OK 'ajout possible' } else { KO "ajout refusé : $($list.reason)"; exit 1 }
$add = Try-J POST '/api/admin/servers' @{ name = 'Deuxième serveur'; port = $list.nextPort; authKey = '00000000-0000-0000-0000-000000000000' } $s
if (-not $add.ok) { KO "ajout : $($add.err)"; Tail; exit 1 }
$sid = $add.data.server.id
OK "serveur ajouté : $sid, démarré=$($add.data.started) $($add.data.error)"
Start-Sleep 8
$st2 = State $s $sid
if ($st2.running) { OK 'serveur 2 en marche' } else { KO "serveur 2 arrêté : $($st2.error)"; Tail }
Start-Sleep 20
if ((Servers) -eq 2 -and (State $s $sid).running -and (State $s 'default').running) { OK '2 BeamMP-Server.exe tournent encore 20 s plus tard' } else { KO "$(Servers) BeamMP-Server.exe" }
$ports = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 30814, $list.nextPort } | ForEach-Object { $_.LocalPort } | Sort-Object -Unique)
OK "ports UDP ouverts : $($ports -join ', ')"
$pub = @(J GET '/api/instances')
if ($pub.Count -eq 2) { OK "page publique : $(($pub | ForEach-Object { $_.name }) -join ' / ')" } else { KO "page publique : $($pub.Count) serveur(s)" }
$sdir = Join-Path $data "servers\$sid"
$client2 = Join-Path $sdir 'Resources\Client'

# ── 5. mod partagé ────────────────────────────────────────────
Say '== mod partagé'
$fl = Try-J POST "/api/i/$sid/mods/from-library" @{ filename = 'zyphro_test_mod.zip' } $s
if ($fl.ok) { OK "ajouté depuis la bibliothèque : $($fl.data.name)" } else { KO "depuis la bibliothèque : $($fl.err)" }
if ((SameFile "$client2\zyphro_test_mod.zip" "$lib\zyphro_test_mod.zip") -eq 'True') { OK "serveur 2 : lien dur ($(Links "$lib\zyphro_test_mod.zip") noms pour un seul fichier)" } else { KO 'serveur 2 : pas de lien dur' }
$c = ($s.Cookies.GetCookies((Url '/')) | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '; '
$code = & curl.exe -s -o NUL -w "%{http_code}" -H "Cookie: $c" -F "file=@$(Join-Path $here 'zyphro_test_mod.zip')" --form-string "name=Doublon" --form-string "type=mod" (Url "/api/i/$sid/mods/upload")
if ($code -eq '409') { OK 'même zip renvoyé sur le serveur 2 : refusé (409), pas de doublon' } else { KO "même zip renvoyé : $code" }
$mid = (Mods $s $sid | Where-Object { $_.filename -eq 'zyphro_test_mod.zip' }).id
Api POST "/api/i/$sid/mods/$mid/toggle" $null $s | Out-Null       # désactivé pendant que le serveur tourne
if (-not (Test-Path "$client2\zyphro_test_mod.zip") -and (Test-Path "$lib\zyphro_test_mod.zip")) { OK 'désactivé à chaud : lien retiré, zip gardé' } else { KO 'désactivation à chaud' }
Api POST "/api/i/$sid/mods/$mid/toggle" $null $s | Out-Null
if ((SameFile "$client2\zyphro_test_mod.zip" "$lib\zyphro_test_mod.zip") -eq 'True') { OK 'réactivé : lien revenu' } else { KO 'réactivation' }
$did = (Mods $s 'default' | Where-Object { $_.filename -eq 'zyphro_test_mod.zip' }).id
$del = Try-J DELETE "/api/i/default/mods/$did" $null $s
if ($del.ok -and -not (Test-Path "$client\zyphro_test_mod.zip") -and (Test-Path "$lib\zyphro_test_mod.zip")) { OK 'supprimé du serveur 1 : zip gardé (serveur 2 l''utilise)' } else { KO "suppression serveur 1 : $($del.err)" }
$ld = Try-J DELETE '/api/library/zyphro_test_mod.zip' $null $s
if (-not $ld.ok) { OK 'bibliothèque : suppression refusée tant que le serveur 2 l''utilise' } else { KO 'bibliothèque : supprimé alors qu''il sert encore' }

# ── 6. redémarrage du panel ───────────────────────────────────
Say '== redémarrage du panel'
& cmd /c (Join-Path $pkg 'Arreter BeamMP Panel.bat') | Out-Null
Start-Sleep 4
if ((Servers) -eq 0) { OK 'arrêt : plus aucun BeamMP-Server' } else { KO "arrêt : $(Servers) BeamMP-Server restant(s)" }
Launch
$r = WaitUp 60
Start-Sleep 25
$s = Login
if ((State $s $sid).running -and (State $s 'default').running) { OK 'les deux serveurs repartent avec le panel' } else { KO 'un serveur ne repart pas'; Tail }

# ── 7. retrait + archive ──────────────────────────────────────
Say '== retrait'
$rm = Try-J DELETE "/api/admin/servers/$sid" $null $s
if ($rm.ok) { OK "retiré, archivé dans $($rm.data.archived)" } else { KO "retrait : $($rm.err)"; Tail }
Start-Sleep 3
if ((Servers) -eq 1) { OK 'un seul BeamMP-Server reste' } else { KO "$(Servers) BeamMP-Server" }
if ($rm.ok -and (Test-Path $rm.data.archived) -and -not (Test-Path $sdir)) { OK 'dossier déplacé dans _archives, rien effacé' } else { KO 'archive absente' }
$entry = @((J GET '/api/library' $null $s).items) | Where-Object { $_.filename -eq 'zyphro_test_mod.zip' }
OK "bibliothèque après retrait : serveurs=$(@($entry.servers).Count) archivés=$(@($entry.archived) -join ',')"
$ld = Try-J DELETE '/api/library/zyphro_test_mod.zip' $null $s
if ($ld.ok -and -not (Test-Path "$lib\zyphro_test_mod.zip")) { OK 'zip des seuls serveurs archivés : supprimé de la bibliothèque' } else { KO "suppression bibliothèque : $($ld.err)" }
if (@(J GET '/api/instances').Count -eq 1) { OK 'page publique : un serveur' } else { KO 'page publique pas à jour' }

# ── 8. arrêt ──────────────────────────────────────────────────
& cmd /c (Join-Path $pkg 'Arreter BeamMP Panel.bat') | Out-Null
Start-Sleep 4
if ((Servers) -eq 0) { OK 'BeamMP-Server arrêté avec le panel' } else { KO 'BeamMP-Server encore en marche' }
try { Api GET '/api/info' | Out-Null; KO 'panel encore actif' } catch { OK 'panel arrêté' }
$crash = @(Select-String -Path (Join-Path $data 'panel.log') -Pattern 'arrêté \(code').Count
if ($crash -eq 0) { OK 'aucun plantage de BeamMP-Server dans panel.log' } else { KO "$crash plantage(s) de BeamMP-Server"; Select-String -Path (Join-Path $data 'panel.log') -Pattern 'arrêté \(code|rangé' | ForEach-Object { Say $_.Line } }
Say "== fin : $script:ko erreur(s)"
