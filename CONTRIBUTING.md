# Contributing to BeamMP Panel

Thank you for your interest in contributing! This document explains how to set up a development
environment and submit changes.

---

## Project structure

```
beammp-panel/
├── server/                 Python engine (Starlette + SQLite) — the API
│   ├── beammp_panel/       application package (routes_*.py, status, logwatch, analyzer…)
│   ├── tests/              pytest suite (API contract, importer)
│   └── requirements.txt
├── frontend/               React + Vite SPA (TypeScript)
├── agent/                  Optional host restart/update agent (Python 3, no deps) + systemd unit
├── scripts/                backup-db.sh, upgrade-to-v3.sh
├── docker-compose.yml
├── Dockerfile              Multi-stage build (frontend → Python image)
└── .env.example            All available configuration variables
```

The v2 engine (Node.js + Fastify + PostgreSQL) lives on the `v2` branch.

## Development setup

### Prerequisites

- Python 3.11+ (3.12 used in the Docker image)
- Node.js 20+ (frontend build only)
- Docker + Docker Compose v2 (optional, to test the image)

### Backend (Python engine)

```bash
cd server
python -m venv ../.venv && ../.venv/bin/pip install -r requirements.txt pytest
../.venv/bin/python -m pytest              # API tests, no network needed
../.venv/bin/python -m beammp_panel --env ../.env
```

### Frontend development

```bash
cd frontend
npm ci
npm run dev        # Vite dev server on :5173 (proxies /api to :3000)
npm run build      # Production build into dist/ (served by the engine)
```

### Docker image

```bash
cp .env.example .env   # set JWT_SECRET, SUPERADMIN_*, BEAMMP_* paths
docker compose up --build
```

---

## Submitting changes

1. **Fork** the repository and create a feature branch from the default branch.
2. Keep commits focused — one logical change per commit.
3. Before opening a PR: `pytest` passes in `server/` and `npm run build` succeeds in
   `frontend/` (CI runs both).
4. The API is a contract with the frontend: a changed route or response shape needs a test.
5. For **security-related changes**, read [SECURITY.md](SECURITY.md) first.
6. Update `.env.example` and the README if you add environment variables.

## Code style

- Python: standard library first, type hints, `ApiError` for HTTP errors, blocking work
  (zip analysis, bcrypt) in `run_in_threadpool`.
- Frontend: TypeScript strict mode, functional components and hooks only.
- No external dependencies without discussion — keep the dependency surface small.

## Reporting bugs

Open a GitHub issue with:
- Steps to reproduce
- Expected vs actual behaviour
- BeamMP Panel version (`X-BeamMP-Panel-Version` response header)
- Docker / OS version

For **security vulnerabilities**, see [SECURITY.md](SECURITY.md) — do not open a public issue.
