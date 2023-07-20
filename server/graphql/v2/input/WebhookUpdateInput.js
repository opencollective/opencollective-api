import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLActivityType } from '../enum/index.js';
import { WebhookReferenceFields } from '../input/WebhookReferenceInput.js';
import URL from '../scalar/URL.js';

export const GraphQLWebhookUpdateInput = new GraphQLInputObjectType({
  name: 'WebhookUpdateInput',
  description: 'Input type to update a Webhook',
  fields: () => ({
    ...WebhookReferenceFields,
    activityType: { type: new GraphQLNonNull(GraphQLActivityType), defaultValue: 'all' },
    webhookUrl: { type: new GraphQLNonNull(URL) },
  }),
});
