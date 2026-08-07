# Security Policy

## Supported Versions

Only the latest release on the `main` branch receives security fixes.

| Version | Supported |
|---------|-----------|
| latest  | ✅        |
| older   | ❌        |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Report them privately via one of the following methods:

1. **GitHub private vulnerability reporting** (preferred):
   Go to *Security → Report a vulnerability* in this repository.

2. **Email**: If you cannot use GitHub's private reporting, open an issue with only the title
   `[SECURITY] Please contact me privately` and we will reach out within 48 hours.

### What to include

- Description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept if possible)
- Affected version / commit hash
- Any suggested mitigation

### Response timeline

| Step | Target |
|------|--------|
| Acknowledgement | 48 hours |
| Initial assessment | 5 business days |
| Fix + release | Depends on severity |

We will credit researchers in the release notes unless you request anonymity.

---

## Security architecture

### Authentication
- Sessions use **httpOnly + Secure + SameSite=Strict** cookies — no token stored in localStorage
- Passwords hashed with **bcrypt** (cost 12) — legacy hashes are transparently migrated on next login
- Login endpoint is rate-limited (5 attempts / minute per IP) via `@fastify/rate-limit`
- JWT secret **must** be at least 32 characters — the app exits at startup if it is missing or default

### Transport
- All traffic should go through a TLS-terminating reverse proxy (Caddy example provided)
- The panel itself does not enforce HTTPS — the reverse proxy is responsible

### File uploads
- Only `.zip` and `.pak` extensions are accepted
- **Magic bytes** are validated: files must start with the ZIP signature (`PK\x03\x04`)
- Filenames are sanitised: only `[a-zA-Z0-9._-]` characters, no path separators
- File size is limited to 500 MB

### Server restart
- The recommended mechanism is the **beammp-agent** (see `beammp-agent.py`)
  — a minimal Python daemon that runs on the host with a whitelist of allowed service names
- Direct command execution (`BEAMMP_RESTART_CMD`) uses `execFile` (no shell) — immune to injection
- The agent verifies a **Bearer token** on every request and only accepts pre-configured service names

### Docker
- The application container runs as the **non-root `node` user** (UID 1000)
- Volume ownership is corrected at startup by `docker-entrypoint.sh` using `su-exec`
- Resource limits (CPU/RAM) are set in `docker-compose.yml`

### Security headers
- `@fastify/helmet` adds standard security headers (CSP, X-Frame-Options, etc.)
- CSP is configured in `strict` mode — no external script/style sources

---

## Known limitations / out of scope

- Multi-user trust: all authenticated users with `admin` or `superadmin` roles have equal
  write access to BeamMP resources. Fine-grained per-user permissions are not implemented.
- The public home page (`/`) exposes server status and active mods — this is intentional and by design.
- Audit logs are stored in the database and can be deleted by a superadmin.
