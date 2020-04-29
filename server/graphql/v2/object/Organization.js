import { GraphQLObjectType, GraphQLString } from 'graphql';

import { Account, AccountFields } from '../interface/Account';

export const Organization = new GraphQLObjectType({
  name: 'Organization',
  description: 'This represents an Organization account',
  interfaces: () => [Account],
  isTypeOf: collective => collective.type === 'ORGANIZATION',
  fields: () => {
    return {
      ...AccountFields,
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
    };
  },
});
