import { GraphQLEnumType } from 'graphql';

export const ActivityAttribution = new GraphQLEnumType({
  name: 'ActivityAttribution',
  description: 'How an activity is related to an account',
  values: {
    AUTHORED: { description: 'Activities initiated by this account' },
    RECEIVED: { description: 'Activities that targeted this account' },
    SELF: { description: 'Activities where author and target both points to this account (e.g. settings update)' },
    HOSTED_ACCOUNTS: { description: 'Activities that happened on accounts hosted by this account' },
  },
});
