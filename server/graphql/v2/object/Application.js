import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { ApplicationType } from '../enum';
import { idEncode } from '../identifiers';

export const Application = new GraphQLObjectType({
  name: 'Application',
  description: 'An oAuth application or a personal token',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve(order) {
        return idEncode(order.id, 'order');
      },
    },
    legacyId: {
      type: new GraphQLNonNull(GraphQLInt),
      resolve(order) {
        return order.id;
      },
    },
    type: {
      type: ApplicationType,
      resolve(application) {
        return application.type;
      },
    },
    name: {
      type: GraphQLString,
      resolve(application) {
        return application.name;
      },
    },
    description: {
      type: GraphQLString,
      resolve(application) {
        return application.description;
      },
    },
    apiKey: {
      type: GraphQLString,
      resolve(application, args, req) {
        if (req.remoteUser && req.remoteUser.CollectiveId === application.CollectiveId) {
          return application.apiKey;
        }
      },
    },
    clientId: {
      type: GraphQLString,
      resolve(application, args, req) {
        if (req.remoteUser && req.remoteUser.CollectiveId === application.CollectiveId) {
          return application.clientId;
        }
      },
    },
    clientSecret: {
      type: GraphQLString,
      resolve(application, args, req) {
        if (req.remoteUser && req.remoteUser.CollectiveId === application.CollectiveId) {
          return application.clientSecret;
        }
      },
    },
    callbackUrl: {
      type: GraphQLString,
      resolve(application, args, req) {
        if (req.remoteUser && req.remoteUser.CollectiveId === application.CollectiveId) {
          return application.callbackUrl;
        }
      },
    },
  }),
});
