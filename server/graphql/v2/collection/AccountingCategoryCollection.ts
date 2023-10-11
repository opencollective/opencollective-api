import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import GraphQLAccountingCategory from '../object/AccountingCategory';

export const GraphQLAccountingCategoryCollection = new GraphQLObjectType({
  name: 'AccountingCategoryCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Accounting Categories"',
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
