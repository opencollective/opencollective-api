import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import GraphQLConversation from '../object/Conversation';

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
