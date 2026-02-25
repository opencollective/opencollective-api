import { GraphQLBoolean, GraphQLInputObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { Update } from '../../../models';
import { GraphQLUpdateAudienceType } from '../enum';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput';

export const GraphQLUpdateUpdateInput = new GraphQLInputObjectType({
  name: 'UpdateUpdateInput',
  description: 'Input type for UpdateType',
  fields: () => ({
    id: { type: GraphQLString, deprecationReason: '2026-02-25: use publicId' },
    publicId: { type: GraphQLString, description: `The resource public id (ie: ${Update.nanoIdPrefix}_xxxxxxxx)` },
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
