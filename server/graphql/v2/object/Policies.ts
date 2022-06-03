import { GraphQLBoolean, GraphQLInt, GraphQLObjectType } from 'graphql';

import POLICIES from '../../../constants/policies';

export const Policies = new GraphQLObjectType({
  name: 'Policies',
  fields: {
    [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: {
      type: GraphQLBoolean,
    },
    [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: {
      type: new GraphQLObjectType({
        name: POLICIES.COLLECTIVE_MINIMUM_ADMINS,
        fields: {
          numberOfAdmins: { type: GraphQLInt },
        },
      }),
    },
  },
});
