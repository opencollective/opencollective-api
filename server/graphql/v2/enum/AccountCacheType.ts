import { GraphQLEnumType } from 'graphql';

export const AccountCacheType = new GraphQLEnumType({
  name: 'AccountCacheType',
  values: {
    CLOUDFLARE: {},
    GRAPHQL_QUERIES: {},
    CONTRIBUTORS: {},
  },
});
