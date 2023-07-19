import { GraphQLObjectType, GraphQLSchema } from 'graphql';

import { ApplicationType } from './Application';
import {
  CollectiveInterfaceType,
  CollectiveSearchResultsType,
  CollectiveStatsType,
  CollectiveType,
  EventCollectiveType,
  FundCollectiveType,
  OrganizationCollectiveType,
  ProjectCollectiveType,
  UserCollectiveType,
  VendorCollectiveType,
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
    ApplicationType,
    CollectiveInterfaceType,
    CollectiveSearchResultsType,
    CollectiveStatsType,
    CollectiveType,
    EventCollectiveType,
    FundCollectiveType,
    OrganizationCollectiveType,
    ProjectCollectiveType,
    TransactionExpenseType,
    TransactionInterfaceType,
    TransactionOrderType,
    UserCollectiveType,
    VendorCollectiveType,
  ],
  query: Query,
  mutation: Mutation,
});

export default Schema;
