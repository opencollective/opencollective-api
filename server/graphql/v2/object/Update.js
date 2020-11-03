import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { stripTags } from '../../../lib/utils';
import { UpdateAudienceType } from '../enum/UpdateAudienceType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { Account } from '../interface/Account';

const Update = new GraphQLObjectType({
  name: 'Update',
  description: 'This represents an Update',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: getIdEncodeResolver(IDENTIFIER_TYPES.UPDATE),
      },
      legacyId: { type: GraphQLInt },
      slug: { type: new GraphQLNonNull(GraphQLString) },
      userCanSeeUpdate: {
        description: 'Indicates whether or not the user is allowed to see the content of this update',
        type: new GraphQLNonNull(GraphQLBoolean),
        resolve(update, _, req) {
          if (!update.isPrivate) {
            return true;
          }
          return req.remoteUser && req.remoteUser.canSeeUpdates(update.CollectiveId);
        },
      },
      isPrivate: { type: new GraphQLNonNull(GraphQLBoolean) },
      title: { type: new GraphQLNonNull(GraphQLString) },
      createdAt: { type: new GraphQLNonNull(GraphQLDateTime) },
      updatedAt: { type: new GraphQLNonNull(GraphQLDateTime) },
      publishedAt: { type: GraphQLDateTime },
      notificationAudience: { type: UpdateAudienceType },
      makePublicOn: { type: GraphQLDateTime },
      summary: {
        type: GraphQLString,
        resolve(update, _, req) {
          if (update.isPrivate && !(req.remoteUser && req.remoteUser.canSeeUpdates(update.CollectiveId))) {
            return null;
          }

          return update.summary || '';
        },
      },
      html: {
        type: GraphQLString,
        resolve(update, _, req) {
          if (update.isPrivate && !(req.remoteUser && req.remoteUser.canSeeUpdates(update.CollectiveId))) {
            return null;
          }

          return stripTags(update.html || '');
        },
      },
      tags: { type: new GraphQLList(GraphQLString) },
      fromAccount: {
        type: Account,
        resolve(update, args, req) {
          return req.loaders.Collective.byId.load(update.FromCollectiveId);
        },
      },
      account: {
        type: Account,
        resolve(update, args, req) {
          return req.loaders.Collective.byId.load(update.CollectiveId);
        },
      },
    };
  },
});

export default Update;
