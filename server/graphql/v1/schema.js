import { GraphQLObjectType, GraphQLSchema } from 'graphql';

import { ApplicationInputType, ApplicationType } from './Application';
import {
  CollectiveInterfaceType,
  CollectiveSearchResultsType,
  CollectiveStatsType,
  CollectiveType,
  EventCollectiveType,
  OrganizationCollectiveType,
  UserCollectiveType,
} from './CollectiveInterface';
import mutation from './mutations';
import query from './queries';
import { TransactionExpenseType, TransactionInterfaceType, TransactionOrderType } from './TransactionInterface';

const Query = new GraphQLObjectType({
  name: 'Query',
  description: 'This is a root query',
  fields: () => {
    return query;
  },
});

const Mutation = new GraphQLObjectType({
  name: 'Mutation',
  description: 'This is the root mutation',
  fields: () => {
    return mutation;
  },
});

const Schema = new GraphQLSchema({
  types: [
    CollectiveInterfaceType,
    CollectiveSearchResultsType,
    CollectiveType,
    CollectiveStatsType,
    UserCollectiveType,
    OrganizationCollectiveType,
    EventCollectiveType,
    TransactionInterfaceType,
    TransactionOrderType,
    TransactionExpenseType,
    ApplicationType,
    ApplicationInputType,
  ],
  query: Query,
  mutation: Mutation,
});

export default Schema;
