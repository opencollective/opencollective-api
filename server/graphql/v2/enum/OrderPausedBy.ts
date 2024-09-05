import { GraphQLEnumType } from 'graphql';

export const GraphQLOrderPausedBy = new GraphQLEnumType({
  name: 'OrderPausedBy',
  description: 'The user or system that paused the order',
  values: {
    USER: {
      value: 'USER',
      description: 'Individual who administers the account for this contribution',
    },
    HOST: {
      value: 'HOST',
      description: 'The host of the collective',
    },
    PLATFORM: {
      value: 'PLATFORM',
      description: 'The platform',
    },
    COLLECTIVE: {
      value: 'COLLECTIVE',
      description: 'The collective',
    },
  },
});
