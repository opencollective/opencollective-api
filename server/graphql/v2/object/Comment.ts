import type { Request } from 'express';
import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';

import { EntityShortIdPrefix, isEntityMigratedToPublicId } from '../../../lib/permalink/entity-map';
import type { Comment } from '../../../models';
import { canSeeComment, collectiveResolver, fromCollectiveResolver } from '../../common/comment';
import { GraphQLCommentType } from '../enum/CommentType';
import { idEncode, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';

import GraphQLConversation from './Conversation';
import { GraphQLExpense } from './Expense';
import { GraphQLHostApplication } from './HostApplication';
import { GraphQLOrder } from './Order';
import GraphQLUpdate from './Update';

export const GraphQLComment = new GraphQLObjectType<Comment, Request>({
  name: 'Comment',
  description: 'This represents an Comment',
  fields: () => {
    return {
      id: {
        type: GraphQLString,
        resolve(comment: Comment) {
          if (isEntityMigratedToPublicId(EntityShortIdPrefix.Comment, comment.createdAt)) {
            return comment.publicId;
          } else {
            return idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
          }
        },
      },
      publicId: {
        type: new GraphQLNonNull(GraphQLString),
        description: `The resource public id (ie: ${EntityShortIdPrefix.Comment}_xxxxxxxx)`,
      },
      createdAt: {
        type: GraphQLDateTime,
      },
      html: {
        type: GraphQLString,
        resolve: async (comment: Comment, _, req: Request) => {
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
        async resolve(comment: Comment, args, req: Request) {
          return await req.loaders.Comment.reactionsByCommentId.load(comment.id);
        },
      },
      userReactions: {
        type: new GraphQLList(GraphQLString),
        description: 'Returns the list of reactions added to this comment by logged in user',
        async resolve(comment: Comment, args, req: Request) {
          if (req.remoteUser) {
            return req.loaders.Comment.remoteUserReactionsByCommentId.load(comment.id);
          }
        },
      },
      // Relationships
      conversation: {
        type: GraphQLConversation,
        resolve(comment: Comment, args, req: Request) {
          if (comment.ConversationId) {
            return req.loaders.Conversation.byId.load(comment.ConversationId);
          }
        },
      },
      expense: {
        type: GraphQLExpense,
        resolve(comment: Comment, args, req: Request) {
          if (comment.ExpenseId) {
            return req.loaders.Expense.byId.load(comment.ExpenseId);
          }
        },
      },
      hostApplication: {
        type: GraphQLHostApplication,
        resolve(comment: Comment, args, req: Request) {
          if (comment.HostApplicationId) {
            return req.loaders.HostApplication.byId.load(comment.HostApplicationId);
          }
        },
      },
      order: {
        type: GraphQLOrder,
        resolve(comment: Comment, args, req: Request) {
          if (comment.OrderId) {
            return req.loaders.Order.byId.load(comment.OrderId);
          }
        },
      },
      update: {
        type: GraphQLUpdate,
        resolve(comment: Comment, args, req: Request) {
          if (comment.UpdateId) {
            return req.loaders.Update.byId.load(comment.UpdateId);
          }
        },
      },
    };
  },
});
