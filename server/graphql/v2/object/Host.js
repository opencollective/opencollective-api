import { GraphQLBoolean, GraphQLInt, GraphQLObjectType } from 'graphql';
import { get } from 'lodash';

import { Account, AccountFields } from '../interface/Account';
import URL from '../scalar/URL';

export const Host = new GraphQLObjectType({
  name: 'Host',
  description: 'This represents an Host account',
  interfaces: () => [Account],
  isTypeOf: collective => collective.isHostAccount,
  fields: () => {
    return {
      ...AccountFields,
      hostFeePercent: {
        type: GraphQLInt,
        resolve(collective) {
          return collective.hostFeePercent;
        },
      },
      totalHostedCollectives: {
        type: GraphQLInt,
        resolve(collective) {
          return collective.getHostedCollectivesCount();
        },
      },
      isOpenToApplications: {
        type: GraphQLBoolean,
        resolve(collective) {
          return collective.canApply();
        },
      },
      termsUrl: {
        type: URL,
        resolve(collective) {
          return get(collective, 'settings.tos');
        },
      },
    };
  },
});
