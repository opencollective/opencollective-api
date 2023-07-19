# Development

## Node and npm

You can play with GraphQL by opening http://localhost:3060/graphql with a tool like [Altair GraphQL](https://altair.sirmuel.design/).

For example, try this query:

```gql
query {
  collective(slug: "apex") {
    id
    slug
    name
    description
    tiers {
      nodes {
        id
        name
        description
        amount {
          value
          currency
        }
      }
    }
    members {
      nodes {
        id
        role
        account {
          id
          slug
          name
        }
        totalDonations {
          value
          currency
        }
      }
    }
  }
}
```

## Tests

```
$> npm test
```

The tests delete all the `opencollective_test` database's tables and
re-create them with the latest models.

All the calls to 3rd party services are stubbed using either `sinon`
or `nock`.

If you get an error at the first test, you might have forgotten to run
postgres. Use e.g. the following aliases to start/stop postgres:

```
export PGDATA='/usr/local/var/postgres'
alias pgstart='pg_ctl -l $PGDATA/server.log start'
alias pgstop='pg_ctl stop -m fast'
```

See
[Wiki](https://github.com/OpenCollective/OpenCollective/wiki/Software-testing)
for more info about the tests.

## Running Scripts

There are many admin scripts in [`/scripts` directory](https://github.com/opencollective/opencollective-api/tree/main/scripts). To run them:

```
# Local development (without Docker)
$ npx ts-node ./scripts/populate_usernames.js
```
