import { GraphQLObjectType } from 'graphql';

import { GraphQLAccount } from '../interface/Account';

export const GraphQLContributorProfile = new GraphQLObjectType({
  name: 'ContributorProfile',
  description: 'This represents a profile that can be use to create a contribution',
  fields: () => ({
    account: {
      type: GraphQLAccount,
      description: 'The account that will be used to create the contribution',
    },
  }),
});
