import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';

import { Account, AccountFields } from '../interface/Account';

import { Host } from './Host';

export const Organization = new GraphQLObjectType({
  name: 'Organization',
  description: 'This represents an Organization account',
  interfaces: () => [Account],
  isTypeOf: collective => collective.type === 'ORGANIZATION',
  fields: () => {
    return {
      ...AccountFields,
      balance: {
        description: 'Amount of money in cents in the currency of the collective currently available to spend',
        deprecationReason: '2020/04/09 - Should not have been introduced. Use stats.balance.value',
        type: GraphQLInt,
        resolve(collective, _, req) {
          return req.loaders.Collective.balance.load(collective.id);
        },
      },
      email: {
        type: GraphQLString,
        resolve(orgCollective, args, req) {
          if (!req.remoteUser) {
            return null;
          }
          return (
            orgCollective && req.loaders.getOrgDetailsByCollectiveId.load(orgCollective.id).then(user => user.email)
          );
        },
      },
      location: {
        ...AccountFields.location,
        description: `
          Address. This field is public for hosts, otherwise:
            - Users can see the addresses of the collectives they're admin of
            - Hosts can see the address of organizations submitting expenses to their collectives
        `,
        async resolve(organization, _, req) {
          const canSeeLocation = req.remoteUser?.isAdmin(organization.id) || (await organization.isHost());
          if (canSeeLocation) {
            return organization.location;
          }
        },
      },
      host: {
        type: Host,
        description: 'If the organization if a host account, this will return the matchig Host object',
        resolve(collective) {
          if (collective.isHost) {
            return collective;
          }
        },
      },
    };
  },
});
