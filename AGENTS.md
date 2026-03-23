# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is the **Open Collective API** — a Node.js/TypeScript backend (Express 5 + Apollo GraphQL) for the Open Collective platform. It uses Sequelize/Kysely for PostgreSQL, Redis for sessions/caching, and MinIO (S3-compatible) for file storage in dev/test.

### Required services

| Service       | Port(s)    | Purpose                    |
| ------------- | ---------- | -------------------------- |
| PostgreSQL 16 | 5432       | Primary database           |
| Redis         | 6379       | Sessions, caching, mutexes |
| MinIO         | 9000, 9001 | S3-compatible file storage |

All three must be running before starting the dev server or running tests.

### Starting services

```bash
# PostgreSQL
sudo pg_ctlcluster 16 main start

# Redis
sudo redis-server --daemonize yes

# MinIO
MINIO_ROOT_USER=user MINIO_ROOT_PASSWORD=password /tmp/minio server /tmp/minio-data --address :9000 --console-address :9001 &
```

### Common commands

See `package.json` scripts and `README.md` for full reference. Key ones:

- **Dev server**: `npm run dev` (serves on port 3060)
- **Lint**: `npm run lint:check` (quiet) or `npm run lint:fix`
- **Prettier**: `npm run prettier:check` or `npm run prettier:write`
- **TypeScript check**: `npx tsc --noEmit`
- **Tests**: `npm run test -- <file>` (e.g. `npm run test test/server/models/User.test.js`)
- **Restore dev DB**: `npm run db:restore && npm run db:migrate`
- **Restore test DB**: `npm run db:restore:test`

### Non-obvious caveats

- The `.nvmrc` specifies Node 24. Use `nvm use` to activate the correct version.
- PostgreSQL must use **trust** authentication for local connections (no password). The `pg_hba.conf` must be configured accordingly.
- The `opencollective` PostgreSQL role needs **superuser** privileges (required by migrations).
- The `postinstall` script (`scripts/postinstall.sh`) will try to restore and migrate the dev database automatically. Set `SKIP_POSTINSTALL=1` to skip this during `npm install` if the database is not yet ready.
- Tests use a separate `opencollective_test` database. Set it up with `npm run db:restore:test` before running tests.
- External service calls (Stripe, PayPal, Wise, etc.) are all stubbed in tests via `nock`/`sinon`; no API keys are needed for test runs.
- MinIO credentials for test config: user `user`, password `password` (configured in `config/test.json`).
- The dev server does not require Redis or MinIO to start, but tests that exercise S3 uploads need MinIO running.
- The pre-commit hook runs `lint-staged` (Prettier formatting on staged files).
