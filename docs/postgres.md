# Database

You need to have Postgres 9.x with the Postgis extension.

## Installation

### On macOS

Last time we checked, the simplest way to get this running was using [Postgres.app](http://postgresapp.com/).

Using brew was not an option:

- `brew install postgresql postgis` would end up with Postgres 10.x
- `brew install postgresql@9.x` would end up with Postgres 9.x without possibility to install Postgis

### Using Docker

If you don't want to run a local instance of Postgres in your computer, you can run one in Docker.
Keep in mind that you still need to have the local client tools like `psql`, `dropdb`, `createuser` still locally available.

Create and run the container:

```
docker run -p 5432:5432 -d --name opencollective-postgres mdillon/postgis:9.6
```

Set the necessary environment variables:

```
export PGHOST=localhost
export PGUSER=postgres
```

## Setting Up The database

Now, assuming the postgres database superuser is `postgres`:

```
createdb -U postgres opencollective_test
createdb -U postgres opencollective_dvl
createuser -U postgres opencollective
psql -U postgres -c 'GRANT ALL PRIVILEGES ON DATABASE opencollective_dvl TO opencollective'
psql -U postgres -c 'GRANT ALL PRIVILEGES ON DATABASE opencollective_test TO opencollective'
psql -U postgres -d opencollective_dvl -c 'CREATE EXTENSION postgis'
psql -U postgres -d opencollective_test -c 'CREATE EXTENSION postgis'
```

## Troubleshooting

For development, ensure that local connections do not require a password. Locate your `pg_hba.conf` file by running `SHOW hba_file;` from the psql prompt (`sudo -i -u postgres` + `psql` after clean install). This should look something like `/etc/postgresql/9.5/main/pg_hba.conf`. We'll call the parent directory of `pg_hba.conf` the `$POSTGRES_DATADIR`. `cd` to `$POSTGRES_DATADIR`, and edit `pg_hba.conf` to `trust` local socket connections and local IP connections. Restart `postgres` - on Mac OS X, there may be restart scripts already in place with `brew`, if not use `pg_ctl -D $POSTGRES_DATADIR restart`.

## FAQ

### error: type "geometry" does not exist

Make sure Postgis is available and activated.
