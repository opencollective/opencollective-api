import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { GraphQLActivityType } from '../enum';
import { idEncode } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';
import URL from '../scalar/URL';

export const GraphQLWebhook = new GraphQLObjectType({
  name: 'Webhook',
  description: 'An webhook attached to an account',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve(notification) {
        return idEncode(notification.id, 'notification');
      },
    },
    legacyId: {
      type: new GraphQLNonNull(GraphQLInt),
      resolve(notification) {
        return notification.id;
      },
    },
    activityType: {
      type: GraphQLActivityType,
      resolve(notification) {
        return notification.type;
      },
    },
    webhookUrl: {
      type: URL,
      resolve(notification) {
        return notification.webhookUrl;
      },
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      resolve(notification, args, req) {
        if (notification.CollectiveId) {
          return req.loaders.Collective.byId.load(notification.CollectiveId);
        }
      },
    },
  }),
});
