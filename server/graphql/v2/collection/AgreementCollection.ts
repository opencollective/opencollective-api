import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { Agreement } from '../object/Agreement';

export const AgreementCollection = new GraphQLObjectType({
  name: 'AgreementCollection',
  interfaces: [Collection],
  description: 'A collection of "Agreement"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(new GraphQLNonNull(Agreement)),
      },
    };
  },
});
