import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { NotificationChannel } from '../enum/NotificationChannel';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { Account } from '../interface/Account';

import { Individual } from './Individual';

export const Notification = new GraphQLObjectType({
  name: 'Notification',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this notification setting',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.NOTIFICATION),
    },
    channel: {
      type: new GraphQLNonNull(NotificationChannel),
      description: 'The channel this setting is notifying through',
    },
    type: {
      // We use String here to cover all legacy and third-party Notifications we have
      type: new GraphQLNonNull(GraphQLString),
      description: 'The type of Activity this setting is notifying about',
    },
    active: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Wheter this notification setting is active or not',
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
    },
    webhookUrl: {
      type: GraphQLString,
      description: 'If channel supports, this is the webhook URL we submit the notification to',
    },
    account: {
      type: Account,
      description: 'The account which this notification setting is applied to',
      resolve(notification, args, req) {
        return req.loaders.Collective.byId.load(notification.CollectiveId);
      },
    },
    individual: {
      type: new GraphQLNonNull(Individual),
      description: 'The user who defined the setting',
      resolve: async (notification, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (notification.UserId) {
          const collective = await req.loaders.Collective.byUserId.load(notification.UserId);
          if (!collective?.isIncognito) {
            return collective;
          }
        }
      },
    },
  }),
});
