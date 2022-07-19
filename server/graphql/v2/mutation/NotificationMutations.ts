import express from 'express';
import { GraphQLNonNull } from 'graphql';

import Channels from '../../../constants/channels';
import models from '../../../models';
import { Unauthorized } from '../../errors';
import { NotificationType } from '../enum/NotificationType';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { Notification } from '../object/Notification';

const notificationMutations = {
  toggleEmailNotification: {
    type: Notification,
    description: 'Toggle email notification subscription for requesting logged-in user',
    args: {
      type: { type: new GraphQLNonNull(NotificationType) },
      account: {
        type: AccountReferenceInput,
        description: 'Scope account which this notification preference is applied to',
      },
    },
    async resolve(_: void, args, req: express.Request) {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to toggle email notification subscription');
      }

      const collective =
        args.account && (await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true }));

      const where = { UserId: req.remoteUser.id, type: args.type };
      if (collective) {
        where['CollectiveId'] = collective.id;
      }

      const existing = await models.Notification.findOne({ where });

      const method =
        existing && existing.active === false ? models.Notification.subscribe : models.Notification.unsubscribe;
      return await method(args.type, Channels.EMAIL, req.remoteUser.id, collective?.id || null);
    },
  },
};

export default notificationMutations;
