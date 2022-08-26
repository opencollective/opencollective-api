import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

/**
 * An input for referencing Conversations
 */
export const ConversationReferenceInput = new GraphQLInputObjectType({
  name: 'ConversationReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the update',
    },
    legacyId: {
      type: GraphQLInt,
    },
  }),
});

export const getConversationDatabaseIdFromUpdateReference = input => {
  if (input['id']) {
    return idDecode(input['id'], IDENTIFIER_TYPES.UPDATE);
  } else if (input['legacyId']) {
    return input['legacyId'];
  } else {
    return null;
  }
};

/**
 * Retrieve an expense from an `ExpenseReferenceInput`
 */
export const fetchConversationWithReference = async (input, { loaders = null, throwIfMissing = false } = {}) => {
  let conversation = null;
  const dbId = getConversationDatabaseIdFromUpdateReference(input);
  if (dbId) {
    conversation = await (loaders ? loaders.Conversation.byId.load(dbId) : models.Conversation.findByPk(dbId));
  }

  if (!conversation && throwIfMissing) {
    throw new NotFound();
  }

  return conversation;
};
