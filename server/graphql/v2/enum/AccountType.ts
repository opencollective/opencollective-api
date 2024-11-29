import { GraphQLEnumType, GraphQLEnumValueConfig } from 'graphql';

import { CollectiveType } from '../../../constants/collectives';

export type GraphQLAccountTypeKeys =
  | 'BOT'
  | 'COLLECTIVE'
  | 'EVENT'
  | 'FUND'
  | 'INDIVIDUAL'
  | 'ORGANIZATION'
  | 'PROJECT'
  | 'VENDOR';

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
  } satisfies Record<GraphQLAccountTypeKeys, GraphQLEnumValueConfig>,
});

export const AccountTypeToModelMapping: Record<GraphQLAccountTypeKeys, CollectiveType> = {
  BOT: CollectiveType.BOT,
  COLLECTIVE: CollectiveType.COLLECTIVE,
  EVENT: CollectiveType.EVENT,
  FUND: CollectiveType.FUND,
  INDIVIDUAL: CollectiveType.USER,
  ORGANIZATION: CollectiveType.ORGANIZATION,
  PROJECT: CollectiveType.PROJECT,
  VENDOR: CollectiveType.VENDOR,
};
