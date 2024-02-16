# PostgreSQL Database

You need to have PostgreSQL > 13.x.

In production, we're currently running 13.7.

## Installation

### On macOS

#### With Homebrew

`brew install postgresql`

Then:

`createuser -s postgres -U <os-username>`

#### With Postgres.app

Get the app from [Postgres.app](http://postgresapp.com/). Install it.

Then to enable the CLI tools, follow the steps from: https://postgresapp.com/documentation/cli-tools.html

### On Linux

#### Fedora / RedHat

```bash
# Install Postgres
sudo dnf install postgresql-server postgresql-contrib

# (Optional) Start postgres at boot time
sudo systemctl enable postgresql

# Initialize DB
PGSETUP_INITDB_OPTIONS="-U postgres" sudo postgresql-setup --initdb
```

Then edit your `/var/lib/pgsql/data/pg_hba.conf`. Comment existing lines, and add the following content:

```
# Allow local connections without password
local   all             all                                     trust
# IPv4 local connections:
host    all             all             127.0.0.1/32            trust
# IPv6 local connections:
host    all             all             ::1/128                 trust
```

Finally start Postgres with `sudo systemctl start postgresql`.

### With Docker

If you don't want to run a local instance of PostgreSQL in your computer, you can run one in Docker.

Create and run the container:

```
docker run -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust -d --name opencollective-postgres --shm-size=1g --memory=4g --cpus=2  postgres:13.7
```

Set the necessary environment variables:

```
export PGHOST=localhost
export PGUSER=postgres
```

You'll also need to have Postgres client tools like `psql`, `dropdb`, `createuser` locally available to run our scripts. In macOS you can install those using Homebrew with:

```
brew install libpq
echo 'export PATH="/usr/local/opt/libpq/bin:$PATH"' >> ~/.bash_profile
```

For Ubuntu 16.04 and above you can execute the following to install Postgres client tools:

```
sudo apt-get install postgresql-client
```

## Setup

#### Development

Please be aware of the `NODE_ENV`/`OC_ENV` variable. By default, it's set to `development` and the `opencollective_dvl` database will be used.

The development database should be automatically installed after `pnpm install`.

To trigger the postinstall script again, run `pnpm postinstall`.

To force a restore run `pnpm db:restore`, then `pnpm db:migrate`.

#### Test

Please be aware of the `NODE_ENV`/`OC_ENV` variable. By default, it's set to `development` and the `opencollective_dvl` database will be used. You have to set it yourself to `test` to switch to the test environment and use `opencollective_test` instead.

To setup the database for tests, run `pnpm db:setup` or run `NODE_ENV=test pnpm db:setup` to force the environment.

If you want to do the steps manually, first, make sure the `opencollective` user is existing:

`createuser opencollective`

Then:

```
createdb opencollective_test
psql -d opencollective_test -c 'GRANT ALL PRIVILEGES ON DATABASE opencollective_test TO opencollective'
```

## Reset

Sometime, things dont't work as expected and you need to start from scratch. Do:

```
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

pnpm db:migration:create -- --name <name-of-your-migration>
```

**Note:** To create a migration, always use the above command, so that it aligns with the default [Sequelize](https://sequelize.org/) file naming conventions.

### Run migrations

This will run all the pending migrations in `migrations/`:

```
pnpm db:migrate
```

### Rollback last migration

```
pnpm db:migrate:undo
```

## Troubleshooting

For development, ensure that local connections do not require a password. Locate your `pg_hba.conf` file by running `SHOW hba_file;` from the psql prompt (`sudo -i -u postgres` + `psql` after clean install). This should look something like `/etc/postgresql/9.5/main/pg_hba.conf`. We'll call the parent directory of `pg_hba.conf` the `$POSTGRES_DATADIR`. `cd` to `$POSTGRES_DATADIR`, and edit `pg_hba.conf` to `trust` local socket connections and local IP connections. Restart `postgres` - on Mac OS X, there may be restart scripts already in place with `brew`, if not use `pg_ctl -D $POSTGRES_DATADIR restart`.
