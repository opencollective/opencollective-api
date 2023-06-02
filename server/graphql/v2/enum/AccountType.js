import { GraphQLEnumType } from 'graphql';

export const GraphQLAccountType = new GraphQLEnumType({
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
    VENDOR: {},
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
  VENDOR: 'VENDOR',
};
