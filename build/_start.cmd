@echo off
rem Lanceur de BeamMP Panel : met en place une mise a jour en attente (app.new), revient a l'ancienne
rem version si la nouvelle n'a pas demarre correctement (app.swapped encore present), puis lance le panel.
cd /d "%~dp0"
if exist app.swapped (
  call :stopall
  if exist app.old (
    rmdir /s /q app 2>nul
    ren app.old app
    echo rolledback> app.rolledback
  )
  del /q app.swapped 2>nul
) else if exist app.new\beammp_panel\__init__.py (
  call :stopall
  if exist app.old rmdir /s /q app.old 2>nul
  if exist app.old ( timeout /t 2 /nobreak >nul & rmdir /s /q app.old 2>nul )
  if not exist app.old (
    ren app app.old 2>nul && ( ren app.new app 2>nul && ( echo swapped> app.swapped ) || ren app.old app )
  )
)
if defined BMP_CONSOLE ( "python\python.exe" -X utf8 -m beammp_panel %* ) else ( start "" "python\pythonw.exe" -X utf8 -m beammp_panel %* )
goto :eof
:stopall
rem arrete les instances de CE dossier (elles gardent des fichiers ouverts et empechent le remplacement)
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$r=(Get-Location).Path+'\python\'; Get-Process pythonw,python -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($r,[StringComparison]::OrdinalIgnoreCase) -and $_.Id -ne $PID } | Stop-Process -Force; Start-Sleep -Milliseconds 900"
exit /b 0
