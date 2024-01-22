// ignore unused exports fetchConversationWithReference

import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import Conversation from '../../../models/Conversation';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

/**
 * An input for referencing Conversations
 */
export const GraphQLConversationReferenceInput = new GraphQLInputObjectType({
  name: 'ConversationReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the conversation',
    },
    legacyId: {
      type: GraphQLInt,
    },
  }),
});

export const getConversationDatabaseIdFromReference = input => {
  if (input['id']) {
    return idDecode(input['id'], IDENTIFIER_TYPES.CONVERSATION);
  } else if (input['legacyId']) {
    return input['legacyId'];
  } else {
    return null;
  }
};

/**
 * Retrieve a conversation from a `ConversationReferenceInput`
 */
export const fetchConversationWithReference = async (input, { loaders = null, throwIfMissing = false } = {}) => {
  let conversation = null;
  const dbId = getConversationDatabaseIdFromReference(input);
  if (dbId) {
    conversation = await (loaders ? loaders.Conversation.byId.load(dbId) : Conversation.findByPk(dbId));
  }

  if (!conversation && throwIfMissing) {
    throw new NotFound();
  }

  return conversation;
};
