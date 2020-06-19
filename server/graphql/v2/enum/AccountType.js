import { GraphQLEnumType } from 'graphql';

export const AccountType = new GraphQLEnumType({
  name: 'AccountType',
  description: 'All account types',
  values: {
    BOT: {},
    COLLECTIVE: {},
    EVENT: {},
    INDIVIDUAL: {},
    ORGANIZATION: {},
    PROJECT: {},
  },
});

export const AccountTypeToModelMapping = {
  BOT: 'BOT',
  COLLECTIVE: 'COLLECTIVE',
  EVENT: 'EVENT',
  INDIVIDUAL: 'USER',
  ORGANIZATION: 'ORGANIZATION',
  PROJECT: 'PROJECT',
};
