import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { stripTags } from '../../../lib/utils';
import models from '../../../models';
import { CommentCollection } from '../collection/CommentCollection';
import { UpdateAudienceType } from '../enum';
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
          return Boolean(req.remoteUser && req.remoteUser.canSeeUpdates(update.CollectiveId));
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
      comments: {
        type: new GraphQLNonNull(CommentCollection),
        description: "List the comments for this update. Not backed by a loader, don't use this in lists.",
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        },
        async resolve(update, _, { limit, offset }) {
          const where = { UpdateId: update.id };
          const order = [['createdAt', 'ASC']];
          const query = { where, order };

          if (limit) {
            query.limit = limit;
          }
          if (offset) {
            query.offset = offset;
          }

          const result = await models.Comment.findAndCountAll(query);
          return { nodes: result.rows, totalCount: result.count, limit, offset };
        },
      },
    };
  },
});

export default Update;
