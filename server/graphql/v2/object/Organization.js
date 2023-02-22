import { GraphQLObjectType, GraphQLString } from 'graphql';

import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { checkScope } from '../../common/scope-check';
import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';

import { GraphQLHost } from './Host';

export const GraphQLOrganization = new GraphQLObjectType({
  name: 'Organization',
  description: 'This represents an Organization account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithContributions],
  isTypeOf: collective => collective.type === 'ORGANIZATION',
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithContributionsFields,
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
          const location = await req.loaders.Location.byCollectiveId.load(organization.id);
          const canSeeLocation =
            (await organization.isHost()) ||
            (checkScope(req, 'account') &&
              (req.remoteUser?.isAdmin(organization.id) ||
                getContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_PROFILE_INFO, organization.id)));

          if (canSeeLocation) {
            return location;
          } else {
            return { country: location?.country };
          }
        },
      },
      host: {
        type: GraphQLHost,
        description: 'If the organization is a host account, this will return the matching Host object',
        resolve(collective) {
          if (collective.isHostAccount) {
            return collective;
          }
        },
      },
    };
  },
});
