import express from 'express';
import { GraphQLNonNull } from 'graphql';

import Channels from '../../../constants/channels';
import models from '../../../models';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { ActivityAndClassesType } from '../enum/ActivityType';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { ActivitySubscriptions } from '../object/ActivitySubscriptions';

const notificationMutations = {
  toggleEmailNotification: {
    type: ActivitySubscriptions,
    description: 'Toggle email notification subscription for requesting logged-in user',
    args: {
      type: { type: new GraphQLNonNull(ActivityAndClassesType) },
      account: {
        type: AccountReferenceInput,
        description: 'Scope account which this notification preference is applied to',
      },
    },
    async resolve(_: void, args, req: express.Request) {
      checkRemoteUserCanUseAccount(req);

      const collective =
        args.account && (await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true }));

      const where = { UserId: req.remoteUser.id, type: args.type };
      if (collective) {
        where['CollectiveId'] = collective.id;
      }

      const existing = await models.Notification.findOne({ where });
      const alreadyUnsubscribed = existing?.active === false;

      if (alreadyUnsubscribed) {
        return models.Notification.subscribe(args.type, Channels.EMAIL, req.remoteUser.id, collective?.id || null);
      } else {
        return models.Notification.unsubscribe(args.type, Channels.EMAIL, req.remoteUser.id, collective?.id || null);
      }
    },
  },
};

export default notificationMutations;
