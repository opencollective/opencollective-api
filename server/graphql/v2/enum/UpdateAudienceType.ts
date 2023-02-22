import { GraphQLEnumType } from 'graphql';

export const GraphQLUpdateAudienceType = new GraphQLEnumType({
  name: 'UpdateAudience',
  description: 'Defines targets for an update',
  values: {
    ALL: {
      description: 'Will be sent to collective admins and financial contributors',
    },
    COLLECTIVE_ADMINS: {
      // TODO Should be renamed to HOSTED_COLLECTIVE_ADMINS
      description: 'Will be sent to collective admins',
    },
    FINANCIAL_CONTRIBUTORS: {
      description: 'Will be sent to financial contributors',
    },
    NO_ONE: {
      description: 'Will be sent to no one',
    },
  },
});
