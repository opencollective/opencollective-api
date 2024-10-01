import { GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLJSONObject } from 'graphql-scalars';

import { GraphQLAccountCollection } from '../collection/AccountCollection';
import { CommentCollection } from '../collection/CommentCollection';
import { GraphQLExpenseCollection } from '../collection/ExpenseCollection';
import { GraphQLHostApplicationCollection } from '../collection/HostApplicationCollection';
import { GraphQLOrderCollection } from '../collection/OrderCollection';
import { GraphQLTierCollection } from '../collection/TierCollection';
import { GraphQLTransactionCollection } from '../collection/TransactionCollection';
import { GraphQLUpdateCollection } from '../collection/UpdateCollection';

const buildSearchResultsType = (name: string, collectionType: GraphQLObjectType) => {
  return {
    description: `Search results for ${name}`,
    type: new GraphQLObjectType({
      name: `SearchResults${name}`,
      fields: {
        collection: { type: new GraphQLNonNull(collectionType) },
        highlights: { type: GraphQLJSONObject },
      },
    }),
  };
};

const GraphQLSearchResults = new GraphQLObjectType({
  name: 'SearchResults',
  description: 'Search results for all types',
  fields: {
    accounts: buildSearchResultsType('Accounts', GraphQLAccountCollection),
    comments: buildSearchResultsType('Comments', CommentCollection),
    expenses: buildSearchResultsType('Expenses', GraphQLExpenseCollection),
    hostApplications: buildSearchResultsType('HostApplications', GraphQLHostApplicationCollection),
    orders: buildSearchResultsType('Orders', GraphQLOrderCollection),
    tiers: buildSearchResultsType('Tiers', GraphQLTierCollection),
    transactions: buildSearchResultsType('Transactions', GraphQLTransactionCollection),
    updates: buildSearchResultsType('Updates', GraphQLUpdateCollection),
  },
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
