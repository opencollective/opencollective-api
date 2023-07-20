import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import { GraphQLAgreement } from '../object/Agreement.js';

export const GraphQLAgreementCollection = new GraphQLObjectType({
  name: 'AgreementCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Agreement"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLAgreement)),
      },
    };
  },
});
