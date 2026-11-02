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
        'test/server/graphql/v1/CollectiveInterface.test.ts',
        'test/server/graphql/v1/collective.test.ts',
        'test/server/graphql/v1/connectedAccounts.test.ts',
        'test/server/graphql/v1/invoices.test.ts',
        'test/server/graphql/v1/mutation.test.ts',
        'test/server/graphql/v1/notifications.test.ts',
        'test/server/graphql/v1/paymentMethods.test.ts',
        'test/server/graphql/v1/search.test.ts',
        'test/server/graphql/v1/tiers.test.ts',
        'test/server/graphql/v1/transaction.test.ts',
        'test/server/graphql/v1/user.test.ts',
        'test/server/graphql/v1/zero-decimal-currencies.test.ts',
        'test/server/paymentProviders/opencollective/giftcard.test.ts',
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
