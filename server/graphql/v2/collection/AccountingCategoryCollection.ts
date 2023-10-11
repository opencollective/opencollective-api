import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import GraphQLAccountingCategory from '../object/AccountingCategory';

export const GraphQLActivityCollection = new GraphQLObjectType({
  name: 'ActivityCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Activities"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLAccountingCategory))),
        description: 'The Accounting Categories',
      },
    };
  },
});
