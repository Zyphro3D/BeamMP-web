#!/usr/bin/env python3
"""
BeamMP Panel — Restart Agent
=============================
Minimal HTTP daemon that lets the (Dockerized) panel restart the BeamMP
systemd service running natively on the host, and — optionally — update the
BeamMP-Server binary itself from an official GitHub release.

Endpoints:
  GET  /health         — liveness probe (no auth)
  GET  /version         — currently installed BeamMP-Server version (auth)
  POST /restart          — restart a BeamMP service via systemd (JSON body: service)
  POST /update-server    — download + install a BeamMP-Server release, then
                            restart (JSON body: service, download_url, sha256)

Security:
  - Bearer token required on every endpoint except /health
  - Service restarts limited to ALLOWED_SERVICES whitelist
  - /update-server only ever downloads from an official BeamMP-Server GitHub
    release asset URL (hardcoded prefix check) and verifies its sha256
    against the value the caller provides (sourced from GitHub's own release
    API by the panel backend) before installing anything — a checksum
    mismatch aborts without touching the existing binary
  - The previous binary is backed up (BINARY_PATH.bak-<timestamp>) before
    being replaced, so a bad release can be rolled back manually
  - No shell execution anywhere (subprocess with an argument list, no shell=True)
  - Binds to a specific interface (the Docker bridge gateway the panel
    container reaches it through), not 0.0.0.0 — not reachable from the LAN

Trimmed down from an earlier version that also exposed generic file
read/write/delete/move endpoints. The panel has only ever called /restart —
that file-ops surface was pure unused attack surface, removed rather than
locked down further. /update-server writes to exactly one path (BINARY_PATH,
whitelisted via systemd's ReadWritePaths=) rather than reintroducing that.
"""

import hmac
import os
import posixpath
import sys
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse

# ── Configuration ──────────────────────────────────────────────────────────────

RESTART_TOKEN    = os.environ.get('RESTART_TOKEN', '')
ALLOWED_SERVICES = [s.strip() for s in os.environ.get('ALLOWED_SERVICES', '').split(',') if s.strip()]
BINARY_PATH      = os.environ.get('BEAMMP_BINARY_PATH', '')
HOST             = os.environ.get('AGENT_HOST', '127.0.0.1')
PORT             = int(os.environ.get('AGENT_PORT', '4445'))

OFFICIAL_RELEASE_PREFIX = 'https://github.com/BeamMP/BeamMP-Server/releases/download/'
OFFICIAL_RELEASE_PATH   = '/BeamMP/BeamMP-Server/releases/download/'
RELEASE_API             = 'https://api.github.com/repos/BeamMP/BeamMP-Server/releases/tags/'
MAX_BINARY_BYTES        = 200 * 1024 * 1024
MAX_BODY_BYTES          = 64 * 1024
_update_lock            = threading.Lock()


def official_asset(url: str):
    """(tag, nom du fichier) si l'URL désigne bien un fichier publié de
    BeamMP/BeamMP-Server, sinon None. On analyse l'URL au lieu de comparer
    son début : « …/download/../../autre/depot/… » passerait sinon."""
    try:
        u = urlparse(url)
    except ValueError:
        return None
    if u.scheme != 'https' or u.netloc != 'github.com' or u.query or u.fragment or u.params:
        return None
    path = u.path
    if '%' in path or '\\' in path or posixpath.normpath(path) != path:
        return None
    if not path.startswith(OFFICIAL_RELEASE_PATH):
        return None
    rest = path[len(OFFICIAL_RELEASE_PATH):].split('/')
    if len(rest) != 2 or not all(rest) or any(p in ('.', '..') for p in rest):
        return None
    return rest[0], rest[1]


def _allowed_redirect(url: str) -> bool:
    host = urlparse(url).hostname or ''
    return urlparse(url).scheme == 'https' and (host == 'github.com' or host.endswith('.githubusercontent.com'))

if not RESTART_TOKEN:
    sys.exit('[beammp-agent] RESTART_TOKEN must be set — generate with: openssl rand -hex 32')

# ── Threading HTTP server ──────────────────────────────────────────────────────

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

# ── Request handler ────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print(f'[beammp-agent] {self.address_string()} — {fmt % args}', flush=True)

    def send_json(self, code: int, body: dict):
        import json
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def check_auth(self) -> bool:
        auth = self.headers.get('Authorization', '')
        if not hmac.compare_digest(auth.encode(), f'Bearer {RESTART_TOKEN}'.encode()):
            self.send_json(401, {'error': 'Unauthorized'})
            return False
        return True

    def read_body_json(self):
        import json
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length > MAX_BODY_BYTES:
                return None
            return json.loads(self.rfile.read(length)) if length > 0 else {}
        except (ValueError, json.JSONDecodeError):
            return None

    def _restart_service(self, service: str):
        """Runs `sudo systemctl restart <service>`. Returns an error dict on
        failure, or None on success. Shared by /restart and /update-server."""
        try:
            result = subprocess.run(
                ['sudo', 'systemctl', 'restart', service],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode != 0:
                msg = (result.stderr or result.stdout or f'exit {result.returncode}').strip()
                self.log_message('ERROR restarting "%s": %s', service, msg)
                return {'error': msg}
        except subprocess.TimeoutExpired:
            return {'error': 'systemctl timed out after 30 s'}
        except FileNotFoundError:
            return {'error': 'systemctl not found'}
        except Exception as exc:
            return {'error': str(exc)}
        return None

    # ── GET ──────────────────────────────────────────────────────────────────

    def do_GET(self):
        path = urlparse(self.path).path

        if path == '/health':
            return self.send_json(200, {'ok': True})

        if path == '/version':
            if not self.check_auth():
                return
            return self._version()

        self.send_json(404, {'error': 'Not found'})

    # ── POST ─────────────────────────────────────────────────────────────────

    def do_POST(self):
        path = urlparse(self.path).path

        if not self.check_auth():
            return

        if path == '/restart':
            return self._restart()
        if path == '/update-server':
            return self._update_server()

        self.send_json(404, {'error': 'Not found'})

    # ── Version ────────────────────────────────────────────────────────────

    def _version(self):
        if not BINARY_PATH:
            return self.send_json(500, {'error': 'BEAMMP_BINARY_PATH not configured on the agent'})
        try:
            result = subprocess.run([BINARY_PATH, '--version'], capture_output=True, text=True, timeout=10)
            version = (result.stdout or result.stderr or '').strip()
            return self.send_json(200, {'version': version})
        except Exception as exc:
            return self.send_json(500, {'error': str(exc)})

    # ── Service restart ───────────────────────────────────────────────────────

    def _restart(self):
        body = self.read_body_json()
        if body is None:
            return self.send_json(400, {'error': 'Invalid JSON body'})
        service = body.get('service', '')
        if not service:
            return self.send_json(400, {'error': '"service" field is required'})
        if service not in ALLOWED_SERVICES:
            self.log_message('DENIED restart of "%s" — not in allowed list', service)
            return self.send_json(403, {'error': f'Service "{service}" is not in the allowed list'})

        err = self._restart_service(service)
        if err:
            return self.send_json(500, err)

        self.log_message('OK — restarted service "%s"', service)
        self.send_json(200, {'restarted': True, 'service': service})

    # ── Server binary update ──────────────────────────────────────────────

    def _update_server(self):
        body = self.read_body_json()
        if body is None:
            return self.send_json(400, {'error': 'Invalid JSON body'})
        service      = body.get('service', '')
        download_url = body.get('download_url', '')
        sha256_expected = body.get('sha256', '')

        if not service or not download_url or not sha256_expected:
            return self.send_json(400, {'error': '"service", "download_url" and "sha256" fields are required'})
        if service not in ALLOWED_SERVICES:
            self.log_message('DENIED update via "%s" — not in allowed list', service)
            return self.send_json(403, {'error': f'Service "{service}" is not in the allowed list'})
        if not BINARY_PATH:
            return self.send_json(500, {'error': 'BEAMMP_BINARY_PATH not configured on the agent'})
        # Only ever download from BeamMP's own official GitHub releases — even
        # though download_url is built by our own trusted panel backend from
        # GitHub's release API, this is defense in depth against a
        # compromised or misconfigured caller directing us to fetch+run an
        # arbitrary binary. The URL is parsed (no '..' tricks) and the sha256
        # is checked against GitHub's own release API, not only the caller's.
        asset = official_asset(download_url)
        if not asset:
            self.log_message('DENIED update — download_url outside BeamMP releases: %s', download_url)
            return self.send_json(403, {'error': 'download_url must be an official BeamMP-Server GitHub release asset'})
        if not _update_lock.acquire(blocking=False):
            return self.send_json(409, {'error': 'An update is already running'})
        try:
            return self._download_and_install(service, download_url, asset, sha256_expected)
        finally:
            _update_lock.release()

    def _official_digest(self, tag: str, name: str):
        import json
        import urllib.parse
        import urllib.request
        req = urllib.request.Request(RELEASE_API + urllib.parse.quote(tag, safe=''),
                                     headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'beammp-agent'})
        with urllib.request.urlopen(req, timeout=20) as resp:
            release = json.loads(resp.read(2 * 1024 * 1024))
        for a in release.get('assets', []):
            if a.get('name') == name:
                digest = str(a.get('digest') or '')
                return digest.split(':', 1)[1].lower() if digest.startswith('sha256:') else None
        return None

    def _download_and_install(self, service, download_url, asset, sha256_expected):
        import urllib.request
        import hashlib
        import shutil
        import tempfile
        import time

        try:
            official = self._official_digest(*asset)
        except Exception as exc:
            return self.send_json(502, {'error': f'GitHub release lookup failed: {exc}'})
        if not official or official != str(sha256_expected).lower():
            self.log_message('DENIED update — sha256 not confirmed by the GitHub release API for %s', download_url)
            return self.send_json(400, {'error': 'sha256 does not match the official GitHub release digest'})

        class _Redirects(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                if not _allowed_redirect(newurl):
                    raise urllib.error.HTTPError(newurl, code, 'redirect outside GitHub refused', headers, fp)
                return super().redirect_request(req, fp, code, msg, headers, newurl)

        import urllib.error
        fd, tmp_path = tempfile.mkstemp(prefix='beammp-server-update-')
        try:
            opener = urllib.request.build_opener(_Redirects)
            size = 0
            digest = hashlib.sha256()
            with opener.open(download_url, timeout=120) as resp, os.fdopen(fd, 'wb') as f:
                for chunk in iter(lambda: resp.read(1 << 20), b''):
                    size += len(chunk)
                    if size > MAX_BINARY_BYTES:
                        raise ValueError('download larger than 200 MiB')
                    digest.update(chunk)
                    f.write(chunk)
        except Exception as exc:
            os.remove(tmp_path)
            return self.send_json(502, {'error': f'Download failed: {exc}'})

        sha256_actual = digest.hexdigest()
        if sha256_actual != official:
            os.remove(tmp_path)
            self.log_message('DENIED update — sha256 mismatch (expected %s, got %s)', official, sha256_actual)
            return self.send_json(400, {'error': 'sha256 mismatch — download corrupted or unexpected file, aborted'})

        backup_path = f'{BINARY_PATH}.bak-{int(time.time())}'
        # staged_path sits in the SAME directory as BINARY_PATH so the final
        # swap is an os.replace() on one filesystem — an atomic rename, which
        # Linux allows even while the old inode is the mapped/running
        # executable (the running process keeps its old inode open; new
        # invocations pick up the new one). A cross-filesystem shutil.move()
        # (e.g. from /tmp) instead falls back to open-and-truncate, which
        # fails with ETXTBSY against a binary that's currently executing.
        staged_path = f'{BINARY_PATH}.new'
        try:
            shutil.copy2(BINARY_PATH, backup_path)
            shutil.copy(tmp_path, staged_path)
            os.chmod(staged_path, 0o755)
            os.replace(staged_path, BINARY_PATH)
        except Exception as exc:
            return self.send_json(500, {'error': f'Failed to install new binary: {exc}'})
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

        err = self._restart_service(service)
        if err:
            return self.send_json(500, {**err, 'note': 'Binary was updated but the restart failed', 'backup': backup_path})

        self.log_message('OK — updated and restarted "%s" (backup: %s)', service, backup_path)
        self.send_json(200, {'updated': True, 'service': service, 'backup': backup_path})

# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f'[beammp-agent] Listening on {HOST}:{PORT}', flush=True)
    print(f'[beammp-agent] Allowed services : {", ".join(ALLOWED_SERVICES)}', flush=True)
    if BINARY_PATH:
        print(f'[beammp-agent] Binary path (for /update-server) : {BINARY_PATH}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('[beammp-agent] Stopped.', flush=True)
