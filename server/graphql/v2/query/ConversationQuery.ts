import express from 'express';
import { GraphQLNonNull, GraphQLString } from 'graphql';

import { assertCanSeeAccount } from '../../../lib/private-accounts';
import { Conversation } from '../../../models';
import { fetchConversationWithReference } from '../input/ConversationReferenceInput';
import GraphQLConversation from '../object/Conversation';

const ConversationQuery = {
  type: GraphQLConversation,
  args: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The id identifying the conversation',
    },
  },
  async resolve(_, args, req: express.Request): Promise<Conversation | null> {
    const conversation = await fetchConversationWithReference(args, { loaders: req.loaders, throwIfMissing: true });
    const collective = await req.loaders.Collective.byId.load(conversation.CollectiveId);
    await assertCanSeeAccount(req, collective);
    return conversation;
  },
};

export default ConversationQuery;
