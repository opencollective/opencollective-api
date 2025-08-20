import { GraphQLEnumType } from 'graphql';

import { ConversationVisibility } from '../../../models/Conversation';

export const GraphQLConversationVisibility = new GraphQLEnumType({
  name: 'ConversationVisibility',
  description: 'Conversation visibility levels',
  values: {
    PUBLIC: {
      description: 'Public conversation visible to everyone',
      value: ConversationVisibility.PUBLIC,
    },
    ADMINS_AND_HOST: {
      description: 'Private conversation visible only to collective admins and host admins',
      value: ConversationVisibility.ADMINS_AND_HOST,
    },
  },
});
