import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';

import models from '../../../models';
import { canSeeComment, collectiveResolver, fromCollectiveResolver } from '../../common/comment';
import { GraphQLCommentType } from '../enum/CommentType';
import { getIdEncodeResolver } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';

import GraphQLConversation from './Conversation';
import { GraphQLExpense } from './Expense';
import { GraphQLHostApplication } from './HostApplication';
import { GraphQLOrder } from './Order';
import GraphQLUpdate from './Update';

export const GraphQLComment = new GraphQLObjectType({
  name: 'Comment',
  description: 'This represents an Comment',
  fields: () => {
    return {
      id: {
        type: GraphQLString,
        deprecationReason: '2026-02-25: use publicId',
        resolve: getIdEncodeResolver('comment'),
      },
      publicId: {
        type: new GraphQLNonNull(GraphQLString),
        description: `The resource public id (ie: ${models.Comment.nanoIdPrefix}_xxxxxxxx)`,
      },
      createdAt: {
        type: GraphQLDateTime,
      },
      html: {
        type: GraphQLString,
        resolve: async (comment, _, req) => {
          if (await canSeeComment(req, comment)) {
            return comment.html;
          }
        },
      },
      fromAccount: {
        type: GraphQLAccount,
        resolve: fromCollectiveResolver,
      },
      account: {
        type: GraphQLAccount,
        resolve: collectiveResolver,
      },
      type: {
        type: new GraphQLNonNull(GraphQLCommentType),
        description: 'The type of this comment',
      },
      reactions: {
        type: GraphQLJSON,
        description: 'Returns a map of reactions counts for this comment',
        async resolve(comment, args, req) {
          return await req.loaders.Comment.reactionsByCommentId.load(comment.id);
        },
      },
      userReactions: {
        type: new GraphQLList(GraphQLString),
        description: 'Returns the list of reactions added to this comment by logged in user',
        async resolve(comment, args, req) {
          if (req.remoteUser) {
            return req.loaders.Comment.remoteUserReactionsByCommentId.load(comment.id);
          }
        },
      },
      // Relationships
      conversation: {
        type: GraphQLConversation,
        resolve(comment, args, req) {
          if (comment.ConversationId) {
            return req.loaders.Conversation.byId.load(comment.ConversationId);
          }
        },
      },
      expense: {
        type: GraphQLExpense,
        resolve(comment, args, req) {
          if (comment.ExpenseId) {
            return req.loaders.Expense.byId.load(comment.ExpenseId);
          }
        },
      },
      hostApplication: {
        type: GraphQLHostApplication,
        resolve(comment, args, req) {
          if (comment.HostApplicationId) {
            return req.loaders.HostApplication.byId.load(comment.HostApplicationId);
          }
        },
      },
      order: {
        type: GraphQLOrder,
        resolve(comment, args, req) {
          if (comment.OrderId) {
            return req.loaders.Order.byId.load(comment.OrderId);
          }
        },
      },
      update: {
        type: GraphQLUpdate,
        resolve(comment, args, req) {
          if (comment.UpdateId) {
            return req.loaders.Update.byId.load(comment.UpdateId);
          }
        },
      },
    };
  },
});
