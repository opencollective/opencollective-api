# AGENTS.md

## Cursor Cloud specific instructions

### Product overview

This repo is **opencollective-api** — the Open Collective backend (Express + GraphQL + Sequelize). The main dev surface is the API at `http://localhost:3060` (GraphQL at `/graphql`).

### System dependencies (VM)

- **Node.js 24.x** and **npm 11.x** (see `.nvmrc`, `package.json` engines). The cloud VM may ship Node 22 at `/exec-daemon/node`; use nvm and put Node 24 first on `PATH` before running npm scripts.
- **PostgreSQL 16+** with client tools (`psql`). `npm postinstall` requires `psql` and a running Postgres on `localhost:5432` with trust auth for local users (see `docs/postgres.md`).
- **Docker** is optional. In this cgroup-limited environment, `docker compose -f docker-compose/db.yml up` may fail; use the native Postgres service instead (`sudo pg_ctlcluster 16 main start`).

### Starting services

1. **PostgreSQL** (required):
   ```bash
   sudo pg_ctlcluster 16 main start
   ```
2. **API** (required for dev):
   ```bash
   npm run dev
   ```
   Listens on port **3060**. GraphQL playground: `http://localhost:3060/graphql`.

Optional local services (see `package.json` scripts): `npm run mailpit`, `npm run minio`, `npm run search`. Tests that touch S3 will warn if MinIO is not running; most unit tests still pass.

### Common commands

| Task                  | Command                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Install deps + dev DB | `npm install` (runs `postinstall` → restores `opencollective_dvl`) |
| Dev server            | `npm run dev`                                                      |
| Lint                  | `npm run lint:check`                                               |
| Type check            | `npm run type:check`                                               |
| Test DB setup         | `npm run db:restore:test`                                          |
| Tests                 | `npm test` or `npm test <path-to-test-file>`                       |

### Hello-world verification

With the API running, query the seeded `apex` collective (from `docs/dev.md`):

```bash
curl -s http://localhost:3060/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"query { collective(slug: \"apex\") { slug name description } }"}'
```

### Gotchas

- GraphQL GET without proper headers returns a CSRF error; use POST with `Content-Type: application/json`.
- Redis is optional in development (in-memory session fallback). CI sets `REDIS_URL`.
- Full browser E2E requires separate repos (`opencollective-frontend`, etc.); not needed for API-only work.
