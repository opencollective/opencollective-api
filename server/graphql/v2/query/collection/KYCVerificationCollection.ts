import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../../interface/Collection';
import { GraphQLKYCVerification } from '../../object/KYCVerification';

export const GraphQLKYCVerificationCollection = new GraphQLObjectType({
  name: 'KYCVerificationCollection',
  interfaces: [GraphQLCollection],
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLKYCVerification)),
      },
    };
  },
});
