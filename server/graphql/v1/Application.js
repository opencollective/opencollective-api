import { GraphQLEnumType, GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';

const ApplicationTypeType = new GraphQLEnumType({
  name: 'ApplicationType',
  description: 'All application types',
  values: {
    API_KEY: { value: 'apiKey' },
    OAUTH: { value: 'oAuth' },
  },
});

export const ApplicationType = new GraphQLObjectType({
  name: 'Application',
  description: 'Application model',
  deprecationReason: '2023-01-03: Depreciated in favor of Personal token. See in GraphQL v2.',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(application) {
          return application.id;
        },
      },
      type: {
        type: ApplicationTypeType,
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
    };
  },
});
