import { GraphQLEnumType } from 'graphql';

export const GraphQLAccountCacheType = new GraphQLEnumType({
  name: 'AccountCacheType',
  values: {
    CLOUDFLARE: {},
    GRAPHQL_QUERIES: {},
    CONTRIBUTORS: {},
  },
});
