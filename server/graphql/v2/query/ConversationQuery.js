import { GraphQLString, GraphQLNonNull } from 'graphql';

import models from '../../../models';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import Conversation from '../object/Conversation';

const ConversationQuery = {
  type: Conversation,
  args: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The id identifying the conversation',
    },
  },
  async resolve(_, args) {
    const id = idDecode(args.id, IDENTIFIER_TYPES.CONVERSATION);
    return models.Conversation.findOne({ where: { id } });
  },
};

export default ConversationQuery;
