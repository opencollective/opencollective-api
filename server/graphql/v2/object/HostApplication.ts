import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';
import { pick } from 'lodash';

import { Unauthorized } from '../../errors';
import { GraphQLHostApplicationStatus } from '../enum/HostApplicationStatus';
import { idEncode, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLHost } from '../object/Host';

export const GraphQLHostApplication = new GraphQLObjectType({
  name: 'HostApplication',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: async application => {
        if (application.id) {
          return idEncode(application.id, IDENTIFIER_TYPES.HOST_APPLICATION);
        } else {
          return idEncode(application.collective.id, IDENTIFIER_TYPES.ACCOUNT);
        }
      },
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      description: 'The account who applied to this host',
      async resolve(application, _, req) {
        return application.collective || req.loaders.Collective.byId.load(application.CollectiveId);
      },
    },
    host: {
      type: new GraphQLNonNull(GraphQLHost),
      description: 'The host the collective applied to',
      async resolve(application, _, req) {
        return application.host || req.loaders.Collective.byId.load(application.HostCollectiveId);
      },
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the item was created',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the item was updated',
    },
    status: {
      type: GraphQLHostApplicationStatus,
    },
    message: {
      type: GraphQLString,
      async resolve(application, _, req) {
        if (
          !req.remoteUser?.isAdmin(application.HostCollectiveId) &&
          !req.remoteUser?.isAdmin(application.CollectiveId)
        ) {
          throw new Unauthorized(
            'You need to be logged in as an admin of the host or the collective to see the host application message',
          );
        }
        return application.message;
      },
    },
    customData: {
      type: GraphQLJSON,
      async resolve(application, _, req) {
        // Unfiltered
        if (
          req.remoteUser?.isAdmin(application.HostCollectiveId) ||
          req.remoteUser?.isAdmin(application.CollectiveId)
        ) {
          return application.customData;
        }
        // Allow-list to support the OSC / GitHub case
        return pick(application.customData, ['repositoryUrl', 'validatedRepositoryInfo']);
      },
    },
  }),
});

export default GraphQLHostApplication;
