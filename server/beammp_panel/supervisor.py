"""Supervision locale de BeamMP-Server (appli Windows, sans systemd ni agent).

Le panel lance lui-même l'exécutable, le relance s'il plante, et sait le
redémarrer ou le mettre à jour depuis la release GitHub officielle, comme
le faisait beammp-agent sous Linux. Le serveur écrit son propre Server.log,
lu par logwatch comme d'habitude.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx

from . import discord
from .config import InstanceConfig

log = logging.getLogger("beammp_panel.supervisor")

RELEASE_URL_PREFIX = "https://github.com/BeamMP/BeamMP-Server/releases/download/"
MAX_BINARY = 200 * 1024 * 1024
STOP_TIMEOUT_S = 10
# Relance automatique bornée : un serveur qui plante en boucle (AuthKey
# refusée, port pris…) ne doit pas tourner indéfiniment.
CRASH_WINDOW_S = 600
CRASH_MAX = 5
HEALTHY_AFTER_S = 8


def _kill_with_panel(pid: int) -> None:
    """Windows : rattache le serveur à un « job » fermé avec le panel.

    Sans ça, un panel arrêté brutalement (gestionnaire des tâches, fermeture
    de session) laisserait BeamMP-Server tourner seul, port occupé.
    """
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    global _job
    if _job is None:
        _job = k32.CreateJobObjectW(None, None)

        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("ReadOperationCount", "WriteOperationCount",
                        "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class EXTENDED(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BASIC), ("IoInfo", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        info = EXTENDED()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        k32.SetInformationJobObject(_job, 9, ctypes.byref(info), ctypes.sizeof(info))  # JobObjectExtendedLimitInformation
    handle = k32.OpenProcess(0x0101, False, pid)  # PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if handle:
        k32.AssignProcessToJobObject(_job, handle)
        k32.CloseHandle(handle)


_job = None


def asset_name() -> str:
    """Suffixe d'asset de la release BeamMP-Server pour ce système."""
    return "exe" if sys.platform == "win32" else ""


def linux_asset() -> str:
    """Suffixe d'asset Linux de ce système (ex. « debian.13.x86_64 »).

    Le conteneur « jeu » utilise la même image que le panel : le panel le calcule chez lui.
    """
    import platform
    info: dict[str, str] = {}
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            k, _, v = line.partition("=")
            info[k] = v.strip().strip('"')
    except OSError:
        return ""
    arch = platform.machine()
    arch = "arm64" if arch == "aarch64" else arch
    return f"{info.get('ID', 'debian')}.{info.get('VERSION_ID', '')}.{arch}" if info.get("VERSION_ID") else ""


class ServerProcess:
    """Un BeamMP-Server lancé par ce processus : dans son dossier de travail, avec un exécutable
    éventuellement partagé par plusieurs serveurs (appli Windows et conteneur « jeu »)."""

    def __init__(self, inst: InstanceConfig, *, notify: bool = True):
        self.inst = inst
        self.exe = Path(inst.server_exe)
        # Dossier de travail : ServerConfig.toml, Resources/, Server.log de CE serveur.
        self.workdir = Path(inst.workdir) if inst.workdir else self.exe.parent
        self.notify = notify         # alertes Discord (le conteneur « jeu » n'en envoie pas)
        self.proc: subprocess.Popen | None = None
        self.wanted = False          # l'utilisateur veut-il le serveur en marche ?
        self.crashes: list[float] = []
        self.last_error = ""
        self._lock = asyncio.Lock()
        self._installing = False
        self._task: asyncio.Task | None = None

    # ── état ──────────────────────────────────────────────────

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    async def fetch_state(self) -> dict:
        return self.state()

    def state(self) -> dict:
        return {"installed": self.exe.is_file(), "running": self.running(), "wanted": self.wanted,
                "pid": self.proc.pid if self.running() else None, "error": self.last_error,
                "exe": str(self.exe), "installing": self._installing}

    # ── démarrage / arrêt ─────────────────────────────────────

    def _spawn(self) -> None:
        if not self.exe.is_file():
            raise FileNotFoundError(f"BeamMP-Server introuvable : {self.exe}")
        if self.inst.workdir and not (self.workdir / "ServerConfig.toml").is_file():
            raise FileNotFoundError(f"ServerConfig.toml introuvable dans {self.workdir}")
        flags = 0
        if sys.platform == "win32":
            flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
        # stdin ouvert mais jamais écrit : la console du serveur attend une
        # entrée ; sans stdin elle lirait une fin de fichier et pourrait s'arrêter.
        self.proc = subprocess.Popen([str(self.exe)], cwd=str(self.workdir), stdin=subprocess.PIPE,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
        try:
            _kill_with_panel(self.proc.pid)
        except OSError:
            log.warning("Rattachement de BeamMP-Server au panel impossible")
        log.info("BeamMP-Server %s démarré (pid %s)", self.inst.id, self.proc.pid)

    def _terminate(self) -> None:
        proc = self.proc
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(STOP_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(5)
        log.info("BeamMP-Server %s arrêté", self.inst.id)

    async def start(self) -> None:
        async with self._lock:
            self.wanted = True
            self.last_error = ""
            if not self.running():
                await asyncio.to_thread(self._spawn)
            self._ensure_watch()

    async def stop(self) -> None:
        async with self._lock:
            self.wanted = False
            await asyncio.to_thread(self._terminate)

    async def restart(self) -> None:
        async with self._lock:
            self.wanted = True
            self.last_error = ""
            await asyncio.to_thread(self._terminate)
            await asyncio.to_thread(self._spawn)
            self._ensure_watch()

    # ── surveillance ──────────────────────────────────────────

    def _ensure_watch(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._watch(), name=f"supervisor-{self.inst.id}")

    async def _watch(self) -> None:
        while True:
            await asyncio.sleep(2)
            if not self.wanted or self.running() or self._lock.locked():
                continue
            now = time.time()
            self.crashes = [t for t in self.crashes if now - t < CRASH_WINDOW_S] + [now]
            code = self.proc.returncode if self.proc else None
            if len(self.crashes) > CRASH_MAX:
                self.wanted = False
                self.last_error = (f"BeamMP-Server s'est arrêté {CRASH_MAX} fois en {CRASH_WINDOW_S // 60} min "
                                   f"(code {code}) : relance automatique suspendue. Voir les journaux.")
                log.error("%s : %s", self.inst.id, self.last_error)
                if self.notify:
                    await discord.notify_crash_loop(self.inst, len(self.crashes), CRASH_WINDOW_S // 60, code)
                continue
            log.warning("BeamMP-Server %s arrêté (code %s), relance dans 5 s", self.inst.id, code)
            notice = discord.CrashNotice(self.inst) if self.notify else None
            if notice:
                await notice.crashed(code)
            await asyncio.sleep(5)
            if self.wanted and not self.running():
                try:
                    async with self._lock:
                        await asyncio.to_thread(self._spawn)
                except OSError as err:
                    self.last_error = str(err)
            # Le message ne passe au vert qu'après quelques secondes de bonne marche.
            if self.running():
                back_at = time.time()
                await asyncio.sleep(HEALTHY_AFTER_S)
                if self.running() and notice:
                    await notice.recovered(back_at, len(self.crashes), CRASH_WINDOW_S // 60)

    async def shutdown(self) -> None:
        if self._task:
            self._task.cancel()
        await asyncio.to_thread(self._terminate)

    # ── version et mise à jour ────────────────────────────────

    async def version(self) -> str:
        if not self.exe.is_file():
            return ""
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

        def run() -> str:
            try:
                r = subprocess.run([str(self.exe), "--version"], cwd=str(self.exe.parent), capture_output=True,
                                   text=True, timeout=15, creationflags=flags)
                return (r.stdout or r.stderr or "").strip()
            except (OSError, subprocess.TimeoutExpired):
                return ""
        return await asyncio.to_thread(run)

    def peers(self) -> list[ServerProcess]:
        """Serveurs de ce processus qui utilisent le même exécutable (lui compris)."""
        return [sp for sp in _servers.values() if sp.exe == self.exe and sp is not self] + [self]

    async def install(self, download_url: str, sha256: str) -> None:
        """Télécharge, vérifie l'empreinte, remplace l'exécutable commun et relance chaque serveur qui
        tournait ; si l'un d'eux ne redémarre pas, l'ancien exécutable est remis pour tous."""
        if not download_url.startswith(RELEASE_URL_PREFIX) or ".." in download_url or "%" in download_url:
            raise ValueError("Adresse de téléchargement inattendue")
        peers = self.peers()
        if any(p._installing for p in peers):
            raise ValueError("Une mise à jour de BeamMP-Server est déjà en cours")
        for p in peers:
            p._installing = True
        try:
            await self._install(download_url, sha256, peers)
        finally:
            for p in peers:
                p._installing = False

    async def _install(self, download_url: str, sha256: str, peers: list[ServerProcess]) -> None:
        tmp = self.exe.with_name(self.exe.name + ".download")
        digest = hashlib.sha256()
        size = 0
        try:
            async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
                async with client.stream("GET", download_url) as res:
                    res.raise_for_status()
                    with open(tmp, "wb") as out:
                        async for chunk in res.aiter_bytes(1024 * 1024):
                            size += len(chunk)
                            if size > MAX_BINARY:
                                raise ValueError("Fichier trop gros")
                            digest.update(chunk)
                            out.write(chunk)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        if digest.hexdigest().lower() != sha256.lower():
            tmp.unlink(missing_ok=True)
            raise ValueError("Empreinte sha256 différente : téléchargement corrompu, rien n'est remplacé")

        backup = self.exe.with_name(self.exe.name + ".bak")
        async with contextlib.AsyncExitStack() as stack:
            for p in peers:
                await stack.enter_async_context(p._lock)
            restart = [p for p in peers if p.wanted or p.running()]
            for p in peers:
                await asyncio.to_thread(p._terminate)
            if self.exe.exists():
                shutil.copy2(self.exe, backup)
            os.replace(tmp, self.exe)
            if sys.platform != "win32":
                self.exe.chmod(0o755)
            if not restart:
                return
            for p in restart:
                await asyncio.to_thread(p._spawn)
        await asyncio.sleep(HEALTHY_AFTER_S)
        failed = [p for p in restart if not p.running()]
        if failed and backup.exists():
            log.error("Le nouveau BeamMP-Server ne démarre pas (%s) : retour à l'ancien",
                      ", ".join(p.inst.id for p in failed))
            async with contextlib.AsyncExitStack() as stack:
                for p in peers:
                    await stack.enter_async_context(p._lock)
                for p in restart:
                    await asyncio.to_thread(p._terminate)
                os.replace(backup, self.exe)
                for p in restart:
                    try:
                        await asyncio.to_thread(p._spawn)
                    except OSError as err:
                        p.last_error = str(err)
            raise RuntimeError("Le nouveau BeamMP-Server ne démarre pas : l'ancien a été remis en place")


class RemoteServer:
    """Serveur qui tourne dans le conteneur « jeu » (Linux) : même interface que ServerProcess, par HTTP.

    Le conteneur retrouve lui-même le dossier du serveur à partir de son identifiant ; le panel
    n'envoie jamais de chemin.
    """

    def __init__(self, inst: InstanceConfig):
        assert inst.runner is not None
        self.inst = inst
        self.runner = inst.runner
        self.exe = Path("")          # l'exécutable est dans le conteneur « jeu »
        self.last_error = ""

    async def _call(self, method: str, path: str, timeout: float = 15, json: dict | None = None) -> dict:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                res = await client.request(method, f"{self.runner.url}{path}", json=json,
                                           headers={"Authorization": f"Bearer {self.runner.token}"})
        except httpx.HTTPError as err:
            raise OSError(f"Conteneur « jeu » injoignable : {err or type(err).__name__}") from err
        try:
            body = res.json()
        except ValueError:
            body = {}
        if res.status_code >= 400:
            raise OSError(body.get("error") or f"Conteneur « jeu » : HTTP {res.status_code}")
        return body

    def _path(self, action: str) -> str:
        return f"/servers/{self.inst.id}/{action}"

    async def fetch_state(self) -> dict:
        try:
            return await self._call("GET", self._path("state"))
        except OSError as err:
            return {"installed": False, "running": False, "wanted": False, "pid": None,
                    "error": str(err), "exe": "", "installing": False, "unreachable": True}

    async def start(self) -> None:
        await self._call("POST", self._path("start"))

    async def stop(self) -> None:
        await self._call("POST", self._path("stop"))

    async def restart(self) -> None:
        await self._call("POST", self._path("restart"), timeout=40)

    async def forget(self) -> None:
        """Arrête le serveur et le retire de la liste du conteneur (avant archivage de son dossier)."""
        await self._call("POST", self._path("forget"), timeout=30)

    async def version(self) -> str:
        try:
            return str((await self._call("GET", "/version", timeout=20)).get("version", ""))
        except OSError:
            return ""

    async def install(self, download_url: str, sha256: str) -> None:
        if not download_url.startswith(RELEASE_URL_PREFIX) or ".." in download_url or "%" in download_url:
            raise ValueError("Adresse de téléchargement inattendue")
        # Téléchargement + remplacement + relance de chaque serveur et contrôle de santé.
        await self._call("POST", "/update", timeout=240, json={"download_url": download_url, "sha256": sha256})

    async def shutdown(self) -> None:   # le conteneur « jeu » vit sa vie : rien à arrêter côté panel
        return None


_servers: dict[str, ServerProcess] = {}


def get(inst: InstanceConfig) -> ServerProcess | RemoteServer | None:
    """Serveur géré par le panel : lancé ici (Windows), ou dans le conteneur « jeu » (Linux) ; None sinon."""
    if inst.server_exe:
        sp = _servers.get(inst.id)
        if sp is None or str(sp.exe) != inst.server_exe or sp.inst.workdir != inst.workdir:
            sp = _servers[inst.id] = ServerProcess(inst)
        return sp
    if inst.runner:
        return RemoteServer(inst)
    return None


async def start_all(instances: list[InstanceConfig]) -> None:
    """Appli Windows : lance chaque serveur local (le conteneur « jeu » relance les siens lui-même)."""
    for inst in instances:
        sp = get(inst)
        if isinstance(sp, ServerProcess) and sp.exe.is_file():
            try:
                await sp.start()
            except OSError as err:
                sp.last_error = str(err)
                log.error("Démarrage de BeamMP-Server impossible : %s", err)


async def stop_all() -> None:
    for sp in list(_servers.values()):
        await sp.shutdown()
    _servers.clear()


async def stop_one(instance_id: str) -> None:
    """Arrête et oublie un serveur local (serveur retiré du panel)."""
    sp = _servers.pop(instance_id, None)
    if sp:
        sp.wanted = False
        await sp.shutdown()


async def download_latest(dest_dir: str) -> str:
    """Installe la dernière version officielle de BeamMP-Server dans dest_dir (assistant de premier lancement)."""
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        res = await client.get("https://api.github.com/repos/BeamMP/BeamMP-Server/releases/latest")
        res.raise_for_status()
        release = res.json()
    suffix = asset_name()
    name = f"BeamMP-Server.{suffix}" if suffix else "BeamMP-Server.debian.13.x86_64"
    asset = next((a for a in release.get("assets", []) if a.get("name") == name), None)
    if not asset or not str(asset.get("digest", "")).startswith("sha256:"):
        raise ValueError(f"Asset {name} introuvable dans la dernière release BeamMP-Server")
    exe_name = "BeamMP-Server.exe" if sys.platform == "win32" else "BeamMP-Server"
    Path(dest_dir).mkdir(parents=True, exist_ok=True)
    fake = InstanceConfig(id="_setup", name="", server_ip="", server_port="", beammp=None, agent=None,  # type: ignore[arg-type]
                          server_exe=str(Path(dest_dir) / exe_name))
    await ServerProcess(fake).install(asset["browser_download_url"], asset["digest"][7:])
    return release.get("tag_name", "")
