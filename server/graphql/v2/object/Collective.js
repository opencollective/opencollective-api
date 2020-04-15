import { GraphQLObjectType, GraphQLInt, GraphQLBoolean } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { hostResolver } from '../../common/collective';
import { Account, AccountFields } from '../interface/Account';

export const Collective = new GraphQLObjectType({
  name: 'Collective',
  description: 'This represents a Collective account',
  interfaces: () => [Account],
  isTypeOf: collective => collective.type === 'COLLECTIVE',
  fields: () => {
    return {
      ...AccountFields,
      balance: {
        description: 'Amount of money in cents in the currency of the collective currently available to spend',
        type: GraphQLInt,
        resolve(collective, _, req) {
          return req.loaders.Collective.balance.load(collective.id);
        },
      },
      host: {
        description: 'Get the host collective that is receiving the money on behalf of this collective',
        type: Account,
        resolve: hostResolver,
      },
      isApproved: {
        description: 'Returns whether this collective is approved',
        type: GraphQLBoolean,
        resolve(collective) {
          return collective.isApproved();
        },
      },
      isArchived: {
        description: 'Returns whether this collective is archived',
        type: GraphQLBoolean,
        resolve(collective) {
          return Boolean(collective.deactivatedAt && !collective.isActive);
        },
      },
      approvedAt: {
        description: 'Return this collective approved date',
        type: GraphQLDateTime,
        resolve(collective) {
          return collective.approvedAt;
        },
      },
    };
  },
});
