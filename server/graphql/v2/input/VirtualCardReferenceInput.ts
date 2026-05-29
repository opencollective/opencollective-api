import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import { EntityShortIdPrefix } from '../../../lib/permalink/entity-map';

export const GraphQLVirtualCardReferenceInput = new GraphQLInputObjectType({
  name: 'VirtualCardReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: `The public id identifying the virtual card (ie: ${EntityShortIdPrefix.VirtualCard}_xxxxxxxx)`,
    },
  }),
});
