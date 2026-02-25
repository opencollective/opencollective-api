import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';

import { Collective, ConnectedAccount } from '../../../models';
import { Unauthorized } from '../../errors';
import { GraphQLConnectedAccountService } from '../enum/ConnectedAccountService';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';

export const GraphQLConnectedAccount = new GraphQLObjectType<ConnectedAccount, Express.Request>({
  name: 'ConnectedAccount',
  description: 'This represents a Connected Account',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this connected account',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.CONNECTED_ACCOUNT),
    },
    publicId: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The resource public id (ie: ${ConnectedAccount.nanoIdPrefix}_xxxxxxxx)`,
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal database identifier of the Connected Account (ie: 580)',
      deprecationReason: '2020-05-01: should only be used during the transition to GraphQL API v2.',
      resolve(connectedAccount): number {
        return connectedAccount.id;
      },
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the ConnectedAccount was created',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the ConnectedAccount was last updated',
    },
    settings: { type: GraphQLJSON },
    service: { type: new GraphQLNonNull(GraphQLConnectedAccountService) },
    accountsMirrored: {
      type: new GraphQLNonNull(new GraphQLList(GraphQLAccount)),
      description: 'The accounts that are mirroring this connected account',
      async resolve(connectedAccount, _, req) {
        if (!req.remoteUser?.isAdmin(connectedAccount.CollectiveId)) {
          throw new Unauthorized('You need to be logged in as an admin of the account');
        }
        const mirroredConnectedAccounts = await ConnectedAccount.findAll({
          where: {
            data: {
              MirrorConnectedAccountId: connectedAccount.id,
            },
          },
          include: [
            {
              model: Collective,
              as: 'collective',
            },
          ],
        });
        return mirroredConnectedAccounts.map(mirroredConnectedAccount => {
          return mirroredConnectedAccount.collective;
        });
      },
    },
    hash: { type: GraphQLString },
    createdByAccount: {
      type: GraphQLAccount,
      description: 'The account who connected this account',
      async resolve(connectedAccount, _, req) {
        if (!req.remoteUser?.isAdmin(connectedAccount.CollectiveId)) {
          throw new Unauthorized('You need to be logged in as an admin of the account');
        }
        if (connectedAccount.CreatedByUserId) {
          const user = await req.loaders.User.byId.load(connectedAccount.CreatedByUserId);
          if (user && user.CollectiveId) {
            const collective = await req.loaders.Collective.byId.load(user.CollectiveId);
            if (collective && !collective.isIncognito) {
              return collective;
            }
          }
        }
      },
    },
  }),
});
