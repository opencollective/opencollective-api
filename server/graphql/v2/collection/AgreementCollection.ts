import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLAgreement } from '../object/Agreement';

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
