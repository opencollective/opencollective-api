import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import GraphQLConversation from '../object/Conversation.js';

export const GraphQLConversationCollection = new GraphQLObjectType({
  name: 'ConversationCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Conversations"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLConversation),
      },
    };
  },
});
