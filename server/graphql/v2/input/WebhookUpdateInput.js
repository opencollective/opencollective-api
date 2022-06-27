import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { ActivityType } from '../enum';
import { WebhookReferenceFields } from '../input/WebhookReferenceInput';
import URL from '../scalar/URL';

export const WebhookUpdateInput = new GraphQLInputObjectType({
  name: 'WebhookUpdateInput',
  description: 'Input type to update a Webhook',
  fields: () => ({
    ...WebhookReferenceFields,
    activityType: { type: new GraphQLNonNull(ActivityType), defaultValue: 'all' },
    webhookUrl: { type: new GraphQLNonNull(URL) },
  }),
});
