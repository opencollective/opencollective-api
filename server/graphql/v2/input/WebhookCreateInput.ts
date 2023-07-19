import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLActivityType } from '../enum/index.js';
import { GraphQLAccountReferenceInput } from '../input/AccountReferenceInput.js';
import URL from '../scalar/URL.js';

export const GraphQLWebhookCreateInput = new GraphQLInputObjectType({
  name: 'WebhookCreateInput',
  description: 'Input type for Webhooks',
  fields: () => ({
    account: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'The account to attach the Webhook',
    },
    activityType: { type: new GraphQLNonNull(GraphQLActivityType), defaultValue: 'all' },
    webhookUrl: { type: new GraphQLNonNull(URL) },
  }),
});
