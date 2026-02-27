import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import models from '../../../models';

export const GraphQLVirtualCardReferenceInput = new GraphQLInputObjectType({
  name: 'VirtualCardReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${models.VirtualCard.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: {
      type: GraphQLString,
      deprecationReason: '2026-02-25: use publicId',
    },
  }),
});
