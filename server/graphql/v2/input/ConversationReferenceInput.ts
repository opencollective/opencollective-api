import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

/**
 * An input for referencing Conversations
 */
export const GraphQLConversationReferenceInput = new GraphQLInputObjectType({
  name: 'ConversationReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${models.Conversation.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: {
      type: GraphQLString,
      description: 'The public id identifying the conversation',
      deprecationReason: '2026-02-25: use publicId',
    },
    legacyId: {
      type: GraphQLInt,
      deprecationReason: '2026-02-25: use publicId',
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
  if (input.publicId) {
    const expectedPrefix = models.Conversation.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for Conversation, expected prefix ${expectedPrefix}_`);
    }

    conversation = await models.Conversation.findOne({ where: { publicId: input.publicId } });
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
