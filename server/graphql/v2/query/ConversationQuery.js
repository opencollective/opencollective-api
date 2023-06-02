import { GraphQLNonNull, GraphQLString } from 'graphql';

import models from '../../../models';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import GraphQLConversation from '../object/Conversation';

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
