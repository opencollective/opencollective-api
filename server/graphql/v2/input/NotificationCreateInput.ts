import { GraphQLBoolean, GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { NotificationChannel } from '../enum/NotificationChannel';
import { NotificationType } from '../enum/NotificationType';

import { AccountReferenceInput } from './AccountReferenceInput';

export const NotificationCreateInput = new GraphQLInputObjectType({
  name: 'NotificationCreateInput',
  description: 'Input to create a new notification setting',
  fields: () => ({
    channel: {
      type: new GraphQLNonNull(NotificationChannel),
      description: 'Notification channel affected by this setting',
    },
    type: {
      type: new GraphQLNonNull(NotificationType),
      description: 'Type of activity which this setting relates to',
    },
    active: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description:
        'Wheter the user wants to be notified or not: True wants to be notified, False does not want to be notified',
    },
    account: {
      type: new GraphQLNonNull(AccountReferenceInput),
      description: 'Scope account which this notification preference is applied to',
    },
  }),
});
