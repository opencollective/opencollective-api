import { GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { getSearchResultFields } from '../../../lib/elastic-search/graphql-search';
import { GraphQLAccountTypeKeys } from '../enum/AccountType';

export type SearchQueryAccountsResolverArgs = {
  type: GraphQLAccountTypeKeys;
  isHost: boolean;
  tags: string[];
};

const GraphQLSearchResults = new GraphQLObjectType({
  name: 'SearchResults',
  description: 'Search results for all types',
  fields: getSearchResultFields,
});

export const GraphQLSearchResponse = new GraphQLObjectType({
  name: 'SearchResponse',
  fields: () => ({
    results: {
      type: new GraphQLNonNull(GraphQLSearchResults),
      description: 'Search results',
    },
  }),
});
