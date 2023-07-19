import { GraphQLBoolean, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput.js';

export const GraphQLUpdateUpdateInput = new GraphQLInputObjectType({
  name: 'UpdateUpdateInput',
  description: 'Input type for UpdateType',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: GraphQLString },
    title: { type: GraphQLString },
    isPrivate: { type: GraphQLBoolean },
    makePublicOn: { type: GraphQLDateTime },
    html: { type: GraphQLString },
    fromAccount: { type: GraphQLAccountReferenceInput },
  }),
});
