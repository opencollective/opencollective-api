import { GraphQLBoolean, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLUpdateAudienceType } from '../enum';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput';

export const GraphQLUpdateCreateInput = new GraphQLInputObjectType({
  name: 'UpdateCreateInput',
  description: 'Input type for UpdateType',
  fields: () => ({
    title: { type: new GraphQLNonNull(GraphQLString) },
    isPrivate: { type: GraphQLBoolean },
    isChangelog: { type: GraphQLBoolean },
    makePublicOn: { type: GraphQLDateTime },
    html: { type: new GraphQLNonNull(GraphQLString) },
    fromAccount: { type: GraphQLAccountReferenceInput },
    account: { type: new GraphQLNonNull(GraphQLAccountReferenceInput) },
    notificationAudience: { type: GraphQLUpdateAudienceType },
  }),
});
