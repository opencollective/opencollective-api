import { GraphQLInputObjectType } from 'graphql';

import { GraphQLActivityType } from '../enum';
import { WebhookReferenceFields } from '../input/WebhookReferenceInput';
import URL from '../scalar/URL';

export const GraphQLWebhookUpdateInput = new GraphQLInputObjectType({
  name: 'WebhookUpdateInput',
  description: 'Input type to update a Webhook. Fields that are not provided are left unchanged.',
  fields: () => ({
    ...WebhookReferenceFields,
    activityType: { type: GraphQLActivityType },
    webhookUrl: { type: URL },
  }),
});
