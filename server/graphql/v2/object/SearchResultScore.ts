import { GraphQLFloat, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

export const GraphQLSearchResultScore = new GraphQLObjectType({
  name: 'SearchResultScore',
  description: 'The score of a search result',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The GraphQL ID of the result (same as the node ID)',
    },
    score: {
      type: new GraphQLNonNull(GraphQLFloat),
      description:
        'Relevance score. With the PostgreSQL backend, scores are comparable across entity types: band * 1000 (5: exact identifier, 4: exact name/title, 3: all words, 2: account name prefix, 1: account name typo) + 500 for accounts + a bonus below 500.',
    },
  }),
});
