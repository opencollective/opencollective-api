import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import models from '../../../models';
import { CommentCollection } from '../collection/CommentCollection';
import { UpdateAudienceType } from '../enum';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { Account } from '../interface/Account';

const canSeeUpdateDetails = (req, update) => {
  if (!update.publishedAt || update.isPrivate) {
    return Boolean(req.remoteUser && req.remoteUser.canSeePrivateUpdates(update.CollectiveId));
  } else {
    return true;
  }
};

const Update = new GraphQLObjectType({
  name: 'Update',
  description: 'This represents an Update',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: getIdEncodeResolver(IDENTIFIER_TYPES.UPDATE),
      },
      legacyId: {
        type: GraphQLInt,
        resolve(update) {
          return update.id;
        },
      },
      slug: { type: new GraphQLNonNull(GraphQLString) },
      userCanSeeUpdate: {
        description: 'Indicates whether or not the user is allowed to see the content of this update',
        type: new GraphQLNonNull(GraphQLBoolean),
        resolve(update, _, req) {
          return canSeeUpdateDetails(req, update);
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
          if (!canSeeUpdateDetails(req, update)) {
            return null;
          } else {
            return update.summary || '';
          }
        },
      },
      html: {
        type: GraphQLString,
        resolve(update, _, req) {
          if (!canSeeUpdateDetails(req, update)) {
            return null;
          } else {
            return update.html;
          }
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
        type: CommentCollection,
        description: "List the comments for this update. Not backed by a loader, don't use this in lists.",
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        },
        async resolve(update, args, req) {
          if (!canSeeUpdateDetails(req, update)) {
            return null;
          }

          const where = { UpdateId: update.id };
          const order = [['createdAt', 'ASC']];
          const query = { where, order };

          if (args.limit) {
            query.limit = args.limit;
          }
          if (args.offset) {
            query.offset = args.offset;
          }

          const result = await models.Comment.findAndCountAll(query);
          return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
        },
      },
    };
  },
});

export default Update;
