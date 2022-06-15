import { GraphQLBoolean, GraphQLEnumType, GraphQLInt, GraphQLObjectType } from 'graphql';

import POLICIES from '../../../constants/policies';

export const Policies = new GraphQLObjectType({
  name: 'Policies',
  fields: () => ({
    [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: {
      type: GraphQLBoolean,
    },
    [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: {
      type: new GraphQLObjectType({
        name: POLICIES.COLLECTIVE_MINIMUM_ADMINS,
        fields: () => ({
          numberOfAdmins: { type: GraphQLInt },
          applies: {
            type: new GraphQLEnumType({
              name: `${POLICIES.COLLECTIVE_MINIMUM_ADMINS}_APPLIES`,
              values: { ALL_COLLECTIVES: { value: 'ALL_COLLECTIVES' }, NEW_COLLECTIVES: { value: 'NEW_COLLECTIVES' } },
            }),
          },
          freeze: { type: GraphQLBoolean },
        }),
      }),
    },
  }),
});
