import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import models, { Op } from '../../../models';
import { GraphQLAccountCollection } from '../collection/AccountCollection';
import { CommentCollection } from '../collection/CommentCollection';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';

import { GraphQLComment } from './Comment';

const GraphQLConversation = new GraphQLObjectType({
  name: 'Conversation',
  description: 'A conversation thread',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: getIdEncodeResolver(IDENTIFIER_TYPES.CONVERSATION),
      },
      slug: { type: new GraphQLNonNull(GraphQLString) },
      title: { type: new GraphQLNonNull(GraphQLString) },
      createdAt: { type: new GraphQLNonNull(GraphQLDateTime) },
      updatedAt: { type: new GraphQLNonNull(GraphQLDateTime) },
      tags: { type: new GraphQLList(GraphQLString) },
      summary: { type: new GraphQLNonNull(GraphQLString) },
      account: {
        type: GraphQLAccount,
        resolve(conversation, args, req) {
          return req.loaders.Collective.byId.load(conversation.CollectiveId);
        },
      },
      fromAccount: {
        type: GraphQLAccount,
        resolve(conversation, args, req) {
          return req.loaders.Collective.byId.load(conversation.FromCollectiveId);
        },
      },
      body: {
        type: GraphQLComment,
        description: 'The root comment / starter for this conversation',
        resolve(conversation) {
          return models.Comment.findByPk(conversation.RootCommentId);
        },
      },
      comments: {
        type: new GraphQLNonNull(CommentCollection),
        description: "List the comments for this conversation. Not backed by a loader, don't use this in lists.",
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 150 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
        },
        async resolve(conversation, { limit, offset }) {
          const where = { ConversationId: conversation.id, id: { [Op.not]: conversation.RootCommentId } };
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
      followers: {
        type: new GraphQLNonNull(GraphQLAccountCollection),
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 10 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
        },
        async resolve(conversation, { offset, limit }, req) {
          const followers = await req.loaders.Conversation.followers.load(conversation.id);
          return {
            nodes: followers.slice(offset, offset + limit),
            totalCount: followers.length,
            offset,
            limit,
          };
        },
      },
      stats: {
        type: new GraphQLObjectType({
          name: 'ConversationStats',
          fields: () => ({
            id: {
              type: new GraphQLNonNull(GraphQLString),
              resolve: getIdEncodeResolver(IDENTIFIER_TYPES.CONVERSATION),
            },
            commentsCount: {
              type: GraphQLInt,
              description: 'Total number of comments for this conversation',
              resolve(conversation, _, req) {
                return req.loaders.Conversation.commentsCount.load(conversation.id);
              },
            },
          }),
        }),
        resolve(conversation) {
          return conversation;
        },
      },
    };
  },
});

export default GraphQLConversation;
