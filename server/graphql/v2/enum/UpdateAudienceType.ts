import { GraphQLEnumType } from 'graphql';

export const UpdateAudienceType = new GraphQLEnumType({
  name: 'UpdateAudienceType',
  description: 'Defines targets for an update',
  values: {
    ALL: {
      description: 'Will be sent to collective admins and financial contributors',
    },
    COLLECTIVE_ADMINS: {
      description: 'Will be sent to collective admins',
    },
    FINANCIAL_CONTRIBUTORS: {
      description: 'Will be sent to financial contributors',
    },
  },
});
