# PostgreSQL Database

Production runs PostgreSQL 16. Use the same major version locally.

## Installation

### With Docker or Podman (recommended)

```bash
docker compose -f docker-compose/db.yml up -d
# or
podman-compose -f docker-compose/db.yml up -d
```

The database scripts use the local Postgres client tools (`psql`, `pg_restore`, ...) when their major
version matches the server's, and otherwise run them from the `postgres:16` image. To skip installing
them, set `USE_DOCKER=true` (or `USE_PODMAN=true`). To install them on macOS, see below.

### Natively

- macOS: `brew install postgresql@16 && brew services start postgresql@16`, add
  `$(brew --prefix postgresql@16)/bin` to your `PATH` (the formula is keg-only), then `createuser -s postgres`
- Linux: install PostgreSQL 16 from your distribution or [postgresql.org](https://www.postgresql.org/download/linux/)

The scripts connect as `postgres` without a password: allow `trust` authentication for local connections
in `pg_hba.conf` (`SHOW hba_file;` in `psql` gives its path).

## Setup

The development database (`opencollective_dvl`) is restored from `test/dbdumps/opencollective_dvl.pgsql`
and migrated by `npm install`. To do it again:

```bash
npm run db:restore && npm run db:migrate
```

The test database (`opencollective_test`, used when `NODE_ENV=test`):

```bash
npm run db:restore:test
```

Both create the `opencollective` role and the extensions the app needs.

### Refreshing the dump

When the dump falls behind the migrations, refresh it and commit the result:

```bash
npm run db:dump:dev                                   # drops and rebuilds opencollective_dvl
DBNAME=opencollective_dump npm run db:dump:dev        # uses another database instead
```

## Reset

To start from scratch:

```bash
dropdb opencollective_dvl
dropdb opencollective_test
dropuser opencollective
```

## Migrations

When creating migrations and interacting with the database please follow the guidelines below.

### Create a migration

This will create a file in `migrations/` where you'll be able to put your migration and rollback procedures:

```
# The name of the migration should use kebab case

npm run db:migration:create -- --name <name-of-your-migration>
```

**Note:** To create a migration, always use the above command, so that it aligns with the default [Sequelize](https://sequelize.org/) file naming conventions.

### Run migrations

This will run all the pending migrations in `migrations/`:

```
npm run db:migrate
```

### Rollback last migration

```
npm run db:migrate:undo
```
