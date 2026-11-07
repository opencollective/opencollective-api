# Development

## Node and npm

You can play with GraphQL by opening http://localhost:3060/graphql with a tool like [Altair GraphQL](https://altairgraphql.dev/).

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

If you get an error at the first test, check that Postgres is running and that the test database
exists (`npm run db:restore:test`). See [PostgreSQL Database](postgres.md).

## Running Scripts

There are many admin scripts in [`/scripts` directory](https://github.com/opencollective/opencollective-api/tree/main/scripts). To run them:

```
# Local development (without Docker)
$ npx babel-node ./scripts/populate_usernames.js
```
