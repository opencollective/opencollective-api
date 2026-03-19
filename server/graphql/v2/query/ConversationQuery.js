import { GraphQLNonNull, GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
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
  async resolve(_, args, req) {
    const id = isEntityPublicId(args.id, EntityShortIdPrefix.Conversation)
      ? await req.loaders.Conversation.idByPublicId.load(args.id)
      : idDecode(args.id, IDENTIFIER_TYPES.CONVERSATION);
    return id ? models.Conversation.findByPk(id) : null;
  },
};

export default ConversationQuery;
