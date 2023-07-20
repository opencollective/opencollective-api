import { GraphQLNonNull, GraphQLString } from 'graphql';

import models from '../../../models/index.js';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers.js';
import GraphQLConversation from '../object/Conversation.js';

const ConversationQuery = {
  type: GraphQLConversation,
  args: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The id identifying the conversation',
    },
  },
  async resolve(_, args) {
    const id = idDecode(args.id, IDENTIFIER_TYPES.CONVERSATION);
    return id ? models.Conversation.findByPk(id) : null;
  },
};

export default ConversationQuery;
