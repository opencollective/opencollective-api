import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { ActivityType } from '../enum';
import { AccountReferenceInput } from '../input/AccountReferenceInput';
import URL from '../scalar/URL';

export const WebhookCreateInput = new GraphQLInputObjectType({
  name: 'WebhookCreateInput',
  description: 'Input type for Webhooks',
  fields: () => ({
    account: {
      type: new GraphQLNonNull(AccountReferenceInput),
      description: 'The account to attach the Webhook',
    },
    activityType: { type: new GraphQLNonNull(ActivityType), defaultValue: 'all' },
    webhookUrl: { type: new GraphQLNonNull(URL) },
  }),
});
