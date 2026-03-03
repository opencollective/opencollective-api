import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import { EntityShortIdPrefix } from '../../../lib/permalink/entity-map';
import models from '../../../models';
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
      description: `The public id identifying the conversation (ie: ${EntityShortIdPrefix.Conversation}_xxxxxxxx)`,
    },
    legacyId: {
      type: GraphQLInt,
      deprecationReason: '2026-02-25: use id',
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
// ts-unused-exports:disable-next-line
export const fetchConversationWithReference = async (input, { loaders = null, throwIfMissing = false } = {}) => {
  let conversation = null;
  if (input.id && typeof input.id === 'string' && input.id.startsWith(`${EntityShortIdPrefix.Conversation}_`)) {
    conversation = await models.Conversation.findOne({ where: { publicId: input.id } });
  } else {
    const dbId = getConversationDatabaseIdFromReference(input);
    if (dbId) {
      conversation = await (loaders ? loaders.Conversation.byId.load(dbId) : models.Conversation.findByPk(dbId));
    }
  }

  if (!conversation && throwIfMissing) {
    throw new NotFound();
  }

  return conversation;
};
