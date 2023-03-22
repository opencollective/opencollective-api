import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';

import { HostApplicationStatus } from '../enum/HostApplicationStatus';
import { idEncode, IDENTIFIER_TYPES } from '../identifiers';
import { Account } from '../interface/Account';

const HostApplication = new GraphQLObjectType({
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
      type: new GraphQLNonNull(Account),
      description: 'The account who applied to this host',
      async resolve(application, _, req) {
        return application.collective || req.loaders.Collective.byId.load(application.CollectiveId);
      },
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the item was created',
    },
    status: {
      type: HostApplicationStatus,
    },
    message: {
      type: GraphQLString,
    },
    customData: {
      type: GraphQLJSON,
    },
  }),
});

export default HostApplication;
