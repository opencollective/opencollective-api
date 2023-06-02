import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import models from '../../../models';
import { createConversation, editConversation } from '../../common/conversations';
import { checkRemoteUserCanUseConversations } from '../../common/scope-check';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import GraphQLConversation from '../object/Conversation';

const conversationMutations = {
  createConversation: {
    type: GraphQLConversation,
    description: 'Create a conversation. Scope: "conversations".',
    args: {
      title: {
        type: new GraphQLNonNull(GraphQLString),
        description: "Conversation's title",
      },
      html: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The body of the conversation initial comment',
      },
      CollectiveId: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'ID of the Collective where the conversation will be created',
      },
      tags: {
        type: new GraphQLList(GraphQLString),
        description: 'A list of tags for this conversation',
      },
    },
    resolve(_, args, req) {
      args.CollectiveId = parseInt(idDecode(args.CollectiveId, 'collective'));
      return createConversation(req, args);
    },
  },
  editConversation: {
    type: GraphQLConversation,
    description: 'Edit a conversation. Scope: "conversations".',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        description: "Conversation's id",
      },
      title: {
        type: new GraphQLNonNull(GraphQLString),
        description: "Conversation's title",
      },
      tags: {
        type: new GraphQLList(GraphQLString),
        description: 'A list of tags for this conversation',
      },
    },
    resolve(_, args, req) {
      args.id = parseInt(idDecode(args.id, IDENTIFIER_TYPES.CONVERSATION));
      return editConversation(req, args);
    },
  },
  followConversation: {
    type: GraphQLBoolean,
    description: 'Returns true if user is following, false otherwise. Must be authenticated. Scope: "conversations".',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        description: "Conversation's id",
      },
      isActive: {
        type: GraphQLBoolean,
        description: 'Set this to false to unfollow the conversation',
        defaultValue: true,
      },
    },
    async resolve(_, { id, isActive }, req) {
      checkRemoteUserCanUseConversations(req);

      const conversationId = parseInt(idDecode(id, IDENTIFIER_TYPES.CONVERSATION));

      if (isActive) {
        await models.ConversationFollower.follow(req.remoteUser.id, conversationId);
        return true;
      } else {
        await models.ConversationFollower.unfollow(req.remoteUser.id, conversationId);
        return false;
      }
    },
  },
};

export default conversationMutations;
