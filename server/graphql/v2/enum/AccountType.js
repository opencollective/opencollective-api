import { GraphQLEnumType } from 'graphql';

export const AccountType = new GraphQLEnumType({
  name: 'AccountType',
  description: 'All account types',
  values: {
    BOT: {},
    COLLECTIVE: {},
    EVENT: {},
    FUND: {},
    INDIVIDUAL: {},
    ORGANIZATION: {},
    PROJECT: {},
  },
});

export const AccountTypeToModelMapping = {
  BOT: 'BOT',
  COLLECTIVE: 'COLLECTIVE',
  EVENT: 'EVENT',
  FUND: 'FUND',
  INDIVIDUAL: 'USER',
  ORGANIZATION: 'ORGANIZATION',
  PROJECT: 'PROJECT',
};
