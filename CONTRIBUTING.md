# Contributing to BeamMP Panel

Thank you for your interest in contributing! This document explains how to set up a development
environment and submit changes.

---

## Project structure

```
beammp-panel/
├── backend/          Node.js + Fastify API (TypeScript)
├── frontend/         React + Vite SPA (TypeScript)
├── beammp-agent.py   Optional host restart agent (Python 3, no deps)
├── beammp-agent.service  systemd unit for the agent
├── docker-compose.yml
├── Dockerfile        Multi-stage build (frontend → backend → production)
└── .env.example      All available configuration variables
```

## Development setup

### Prerequisites

- Docker + Docker Compose v2
- Node.js 20+ (for local TypeScript compilation / IDE support)
- Python 3.8+ (if working on the agent)

### First run

```bash
cp beammp-panel/.env.example beammp-panel/.env
# Edit .env: set JWT_SECRET, POSTGRES_PASSWORD, SUPERADMIN_*
cd beammp-panel
docker compose up --build
```

The panel is available at `http://localhost:3000`.

### Backend development

```bash
cd beammp-panel/backend
npm install
npm run build      # TypeScript compile
npm run dev        # ts-node-dev watch mode (if configured)
```

### Frontend development

```bash
cd beammp-panel/frontend
npm install
npm run dev        # Vite dev server on :5173 (proxies /api to :3000)
npm run build      # Production build into dist/
```

---

## Submitting changes

1. **Fork** the repository and create a feature branch from `main`.
2. Keep commits focused — one logical change per commit.
3. Run `npm run build` in both `backend/` and `frontend/` before opening a PR — the Docker
   build must succeed.
4. For **security-related changes**, read [SECURITY.md](SECURITY.md) first.
5. Update `.env.example` if you add new environment variables.
6. Open a Pull Request against `main` with a clear description of the change and why it is needed.

## Code style

- TypeScript strict mode is enforced — no `any` unless absolutely necessary.
- Backend: Fastify route handlers follow the existing pattern (typed params/body, `preHandler: requireAuth`).
- Frontend: functional components, hooks only — no class components except the Error Boundary.
- No external dependencies without discussion — keep the dependency surface small.

## Reporting bugs

Open a GitHub issue with:
- Steps to reproduce
- Expected vs actual behaviour
- BeamMP Panel version (`X-BeamMP-Panel-Version` response header)
- Docker / OS version

For **security vulnerabilities**, see [SECURITY.md](SECURITY.md) — do not open a public issue.
