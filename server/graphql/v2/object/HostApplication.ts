import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';
import { pick } from 'lodash';

import models from '../../../models';
import { CommentType } from '../../../models/Comment';
import { Unauthorized } from '../../errors';
import { CommentCollection } from '../collection/CommentCollection';
import { GraphQLHostApplicationStatus } from '../enum/HostApplicationStatus';
import { idEncode, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { GraphQLAccount } from '../interface/Account';
import { CollectionArgs } from '../interface/Collection';
import { GraphQLHost } from '../object/Host';

export const GraphQLHostApplication = new GraphQLObjectType({
  name: 'HostApplication',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: async application => {
        if (application.id) {
          return idEncode(application.id, IDENTIFIER_TYPES.HOST_APPLICATION);
        } else {
          return idEncode(application.collective.id, IDENTIFIER_TYPES.ACCOUNT);
        }
      },
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      description: 'The account who applied to this host',
      async resolve(application, _, req) {
        return application.collective || req.loaders.Collective.byId.load(application.CollectiveId);
      },
    },
    host: {
      type: new GraphQLNonNull(GraphQLHost),
      description: 'The host the collective applied to',
      async resolve(application, _, req) {
        return application.host || req.loaders.Collective.byId.load(application.HostCollectiveId);
      },
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the item was created',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the item was updated',
    },
    status: {
      type: GraphQLHostApplicationStatus,
    },
    message: {
      type: GraphQLString,
      async resolve(application, _, req) {
        if (
          !req.remoteUser?.isAdmin(application.HostCollectiveId) &&
          !req.remoteUser?.isAdmin(application.CollectiveId)
        ) {
          throw new Unauthorized(
            'You need to be logged in as an admin of the host or the collective to see the host application message',
          );
        }
        return application.message;
      },
    },
    customData: {
      type: GraphQLJSON,
      async resolve(application, _, req) {
        // Unfiltered
        if (
          req.remoteUser?.isAdmin(application.HostCollectiveId) ||
          req.remoteUser?.isAdmin(application.CollectiveId)
        ) {
          return application.customData;
        }
        // Allow-list to support the OSC / GitHub case
        return pick(application.customData, ['repositoryUrl', 'validatedRepositoryInfo']);
      },
    },
    comments: {
      type: CommentCollection,
      description:
        'Returns the list of comments for this host application, or `null` if user is not allowed to see them',
      args: {
        ...CollectionArgs,
        orderBy: {
          type: GraphQLChronologicalOrderInput,
          defaultValue: { field: 'createdAt', direction: 'ASC' },
        },
      },
      async resolve(hostApplication, { limit, offset, orderBy }, req) {
        if (
          !req.remoteUser?.isAdmin(hostApplication.HostCollectiveId) &&
          !req.remoteUser?.isAdmin(hostApplication.CollectiveId)
        ) {
          return null;
        }

        const type = [CommentType.COMMENT];
        if (req.remoteUser?.isAdmin(hostApplication.HostCollectiveId)) {
          type.push(CommentType.PRIVATE_NOTE);
        }

        return {
          offset,
          limit,
          totalCount: async () => {
            const counts = await req.loaders.Comment.countByHostApplication.load(hostApplication.id);
            if (req.remoteUser?.isAdmin(hostApplication.HostCollectiveId)) {
              return counts.comments + counts.privateNotes;
            } else {
              return counts.comments;
            }
          },
          nodes: async () =>
            models.Comment.findAll({
              where: { HostApplicationId: hostApplication.id, type },
              order: [[orderBy.field, orderBy.direction]],
              offset,
              limit,
            }),
        };
      },
    },
  }),
});
