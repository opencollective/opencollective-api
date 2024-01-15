// eslint-disable-next-line import/no-commonjs
module.exports = {
  projects: {
    default: {
      schema: 'server/graphql/schemaV2.graphql',
      extensions: {
        endpoints: {
          dev: 'http://localhost:3060/graphql/v2',
          prod: 'https://api.opencollective.com/graphql/v2',
        },
        pluckConfig: {
          globalGqlIdentifierName: 'gql',
          gqlMagicComment: 'GraphQLV2',
        },
      },
    },
    graphqlV1: {
      schema: 'server/graphql/schemaV1.graphql',
      documents: [
        // The following documents only use gqlV1
        // grep -rl " gqlV1\`" ./test | xargs grep -rL "gql\`" | sort
        'test/server/graphql/v1/CollectiveInterface.test.js',
        'test/server/graphql/v1/allHosts.test.js',
        'test/server/graphql/v1/collective.test.js',
        'test/server/graphql/v1/connectedAccounts.test.js',
        'test/server/graphql/v1/invoices.test.js',
        'test/server/graphql/v1/mutation.test.js',
        'test/server/graphql/v1/notifications.test.js',
        'test/server/graphql/v1/paymentMethods.test.js',
        'test/server/graphql/v1/search.test.js',
        'test/server/graphql/v1/tiers.test.js',
        'test/server/graphql/v1/transaction.test.js',
        'test/server/graphql/v1/user.test.js',
        'test/server/graphql/v1/zero-decimal-currencies.test.js',
        'test/server/paymentProviders/opencollective/giftcard.test.js',
        // The following documents use gql and gqlV1 at the same time, gqlV1 will not be linted
        // grep -rl " gqlV1\`" ./test | xargs grep -rl "gql\`" | sort
        // No file anymore and it should stay like that!
      ],
      extensions: {
        endpoints: {
          dev: 'http://localhost:3060/graphql/v1',
          prod: 'https://api.opencollective.com/graphql/v1',
        },
        pluckConfig: {
          globalGqlIdentifierName: 'gqlV1',
          gqlMagicComment: 'GraphQL',
        },
      },
    },
  },
};
