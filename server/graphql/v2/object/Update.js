import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';

import { CollectiveType } from '../../../constants/collectives';
import models from '../../../models';
import { UpdateChannel } from '../../../models/Update';
import { canSeeUpdate } from '../../common/update';
import { CommentCollection } from '../collection/CommentCollection';
import { GraphQLUpdateAudienceType } from '../enum';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';

import { GraphQLUpdateAudienceStats } from './UpdateAudienceStats';

const GraphQLUpdate = new GraphQLObjectType({
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
          return canSeeUpdate(req, update);
        },
      },
      userCanPublishUpdate: {
        description: 'Indicates whether or not the user is allowed to publish this update',
        type: new GraphQLNonNull(GraphQLBoolean),
        async resolve(update, _, req) {
          if (!req.remoteUser || update.publishedAt) {
            return false;
          } else {
            update.collective = update.collective || (await req.loaders.Collective.byId.load(update.CollectiveId));
            return Boolean(req.remoteUser.isAdminOfCollective(update.collective));
          }
        },
      },
      isPrivate: { type: new GraphQLNonNull(GraphQLBoolean) },
      isChangelog: { type: new GraphQLNonNull(GraphQLBoolean) },
      title: { type: new GraphQLNonNull(GraphQLString) },
      createdAt: { type: new GraphQLNonNull(GraphQLDateTime) },
      updatedAt: { type: new GraphQLNonNull(GraphQLDateTime) },
      publishedAt: { type: GraphQLDateTime },
      notificationAudience: { type: GraphQLUpdateAudienceType },
      audienceStats: {
        type: GraphQLUpdateAudienceStats,
        description: `Some stats about the target audience. Will be null if the update is already published or if you don't have enough permissions so see this information. Not backed by a loader, avoid using this field in lists.`,
        args: {
          audience: {
            type: GraphQLUpdateAudienceType,
            description: 'To override the default notificationAudience',
          },
        },
        async resolve(update, args, req) {
          if (!req.remoteUser || update.publishedAt) {
            return null;
          }

          update.collective = update.collective || (await req.loaders.Collective.byId.load(update.CollectiveId));

          if (
            !req.remoteUser.isAdminOfCollective(update.collective) &&
            !req.remoteUser.isCommunityManager(update.collective)
          ) {
            return null;
          }

          const audience = args.audience || update.notificationAudience || 'ALL';
          let membersStats = {};
          let hostedCollectivesCount = 0;

          if (audience === 'NO_ONE') {
            return {
              id: `${update.id}-${audience}`,
              individuals: 0,
              organizations: 0,
              collectives: 0,
              coreContributors: 0,
              hosted: 0,
              total: 0,
            };
          }

          if (audience !== 'COLLECTIVE_ADMINS') {
            membersStats = await update.getAudienceMembersStats(audience, UpdateChannel.EMAIL);
          }

          if (update.collective.isHostAccount && (audience === 'ALL' || audience === 'COLLECTIVE_ADMINS')) {
            hostedCollectivesCount = await update.collective.getHostedCollectivesCount();
          }

          return {
            id: `${update.id}-${audience}`,
            individuals: membersStats[CollectiveType.USER] || 0,
            organizations: membersStats[CollectiveType.ORGANIZATION] || 0,
            collectives: membersStats[CollectiveType.COLLECTIVE] || 0,
            coreContributors: membersStats['CORE_CONTRIBUTOR'] || 0,
            hosted: hostedCollectivesCount || 0,
            total: await update.countUsersToNotify(audience, UpdateChannel.EMAIL),
          };
        },
      },
      makePublicOn: { type: GraphQLDateTime },
      summary: {
        type: GraphQLString,
        async resolve(update, _, req) {
          if (!(await canSeeUpdate(req, update))) {
            return null;
          } else {
            return update.summary || '';
          }
        },
      },
      html: {
        type: GraphQLString,
        async resolve(update, _, req) {
          if (!(await canSeeUpdate(req, update))) {
            return null;
          } else {
            return update.html;
          }
        },
      },
      tags: { type: new GraphQLList(GraphQLString) },
      fromAccount: {
        type: GraphQLAccount,
        resolve(update, args, req) {
          return req.loaders.Collective.byId.load(update.FromCollectiveId);
        },
      },
      account: {
        type: GraphQLAccount,
        resolve(update, args, req) {
          return req.loaders.Collective.byId.load(update.CollectiveId);
        },
      },
      reactions: {
        type: GraphQLJSON,
        description: 'Returns a map of reactions counts for this update',
        async resolve(update, args, req) {
          return req.loaders.Update.reactionsByUpdateId.load(update.id);
        },
      },
      userReactions: {
        type: new GraphQLList(GraphQLString),
        description: 'Returns the list of reactions added to this update by logged in user',
        async resolve(update, args, req) {
          if (req.remoteUser) {
            return req.loaders.Update.remoteUserReactionsByUpdateId.load(update.id);
          }
        },
      },
      comments: {
        type: CommentCollection,
        description: "List the comments for this update. Not backed by a loader, don't use this in lists.",
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 150 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
        },
        async resolve(update, args, req) {
          if (!(await canSeeUpdate(req, update))) {
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

export default GraphQLUpdate;
