import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';

import { Account, AccountFields } from '../interface/Account';
import { AccountWithContributions, AccountWithContributionsFields } from '../interface/AccountWithContributions';

import { Host } from './Host';

export const Organization = new GraphQLObjectType({
  name: 'Organization',
  description: 'This represents an Organization account',
  interfaces: () => [Account, AccountWithContributions],
  isTypeOf: collective => collective.type === 'ORGANIZATION',
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithContributionsFields,
      balance: {
        description: 'Amount of money in cents in the currency of the collective currently available to spend',
        deprecationReason: '2020/04/09 - Should not have been introduced. Use stats.balance.value',
        type: GraphQLInt,
        resolve(account, _, req) {
          return account.getBalanceWithBlockedFunds({ loaders: req.loaders });
        },
      },
      email: {
        type: GraphQLString,
        deprecationReason: '2022-07-18: This field is deprecated and will return null',
        resolve: () => null,
      },
      location: {
        ...AccountFields.location,
        description: `
          Address. This field is public for hosts, otherwise:
            - Users can see the addresses of the collectives they're admin of; if they are not an admin they can only see the country that the org belong to.
            - Hosts can see the address of organizations submitting expenses to their collectives.
        `,
        async resolve(organization, _, req) {
          const canSeeLocation = req.remoteUser?.isAdmin(organization.id) || (await organization.isHost());
          if (canSeeLocation) {
            return organization.location;
          } else {
            return { country: organization.location?.country };
          }
        },
      },
      host: {
        type: Host,
        description: 'If the organization if a host account, this will return the matching Host object',
        resolve(collective) {
          if (collective.isHostAccount) {
            return collective;
          }
        },
      },
    };
  },
});
