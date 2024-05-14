import { GraphQLBoolean, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLUpdateAudienceType } from '../enum';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput';

export const GraphQLUpdateUpdateInput = new GraphQLInputObjectType({
  name: 'UpdateUpdateInput',
  description: 'Input type for UpdateType',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: GraphQLString },
    title: { type: GraphQLString },
    isPrivate: { type: GraphQLBoolean },
    isChangelog: { type: GraphQLBoolean },
    makePublicOn: { type: GraphQLDateTime },
    html: { type: GraphQLString },
    fromAccount: { type: GraphQLAccountReferenceInput },
    notificationAudience: { type: GraphQLUpdateAudienceType },
  }),
});
