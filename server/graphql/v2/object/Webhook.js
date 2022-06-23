import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { ActivityType } from '../enum';
import { idEncode } from '../identifiers';
import { Account } from '../interface/Account';
import URL from '../scalar/URL';

export const Webhook = new GraphQLObjectType({
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
      type: ActivityType,
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
      type: new GraphQLNonNull(Account),
      resolve(notification, args, req) {
        return req.loaders.Collective.byId.load(notification.CollectiveId);
      },
    },
  }),
});
