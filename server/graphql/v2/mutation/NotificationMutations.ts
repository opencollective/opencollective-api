import express from 'express';
import { GraphQLNonNull } from 'graphql';

import models from '../../../models';
import { Unauthorized } from '../../errors';
import { fetchAccountWithReference } from '../input/AccountReferenceInput';
import { NotificationCreateInput } from '../input/NotificationCreateInput';
import { Notification } from '../object/Notification';

const notificationMutations = {
  subscribeToNotification: {
    type: Notification,
    description: 'Subscribe to specific notifications',
    args: {
      notification: {
        type: new GraphQLNonNull(NotificationCreateInput),
        description: 'Connected Account data',
      },
    },
    async resolve(_: void, args, req: express.Request) {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to create a notification setting');
      }

      const collective =
        args.notification.account &&
        (await fetchAccountWithReference(args.notification.account, { loaders: req.loaders, throwIfMissing: true }));

      return await models.Notification.subscribe(
        args.notification.type,
        args.notification.channel,
        req.remoteUser.id,
        collective?.id || null,
      );
    },
  },
  unsubscribeToNotification: {
    type: Notification,
    description: 'Unsubscribe from specific notifications',
    args: {
      notification: {
        type: new GraphQLNonNull(NotificationCreateInput),
        description: 'Connected Account data',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to delete a connected account');
      }
      const collective =
        args.notification.account &&
        (await fetchAccountWithReference(args.notification.account, { loaders: req.loaders, throwIfMissing: true }));

      return await models.Notification.unsubscribe(
        args.notification.type,
        args.notification.channel,
        req.remoteUser.id,
        collective?.id || null,
      );
    },
  },
};

export default notificationMutations;
