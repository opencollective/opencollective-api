import express from 'express';
import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import Channels from '../../../constants/channels';
import models from '../../../models';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { GraphQLActivityAndClassesType } from '../enum/ActivityType';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLActivitySubscription } from '../object/ActivitySubscription';

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
