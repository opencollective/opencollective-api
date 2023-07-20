import express from 'express';
import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import Channels from '../../../constants/channels.js';
import models from '../../../models/index.js';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check.js';
import { GraphQLActivityAndClassesType } from '../enum/ActivityType.js';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput.js';
import { GraphQLActivitySubscription } from '../object/ActivitySubscription.js';

const notificationMutations = {
  setEmailNotification: {
    type: GraphQLActivitySubscription,
    description: 'Set email notification subscription for requesting logged-in user',
    args: {
      type: { type: new GraphQLNonNull(GraphQLActivityAndClassesType) },
      account: {
        type: GraphQLAccountReferenceInput,
        description: 'Scope account which this notification preference is applied to',
      },
      active: { type: new GraphQLNonNull(GraphQLBoolean) },
    },
    async resolve(_: void, args, req: express.Request) {
      checkRemoteUserCanUseAccount(req);

      const collective =
        args.account && (await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true }));

      if (args.active) {
        return models.Notification.subscribe(args.type, Channels.EMAIL, req.remoteUser.id, collective?.id || null);
      } else {
        return models.Notification.unsubscribe(args.type, Channels.EMAIL, req.remoteUser.id, collective?.id || null);
      }
    },
  },
};

export default notificationMutations;
