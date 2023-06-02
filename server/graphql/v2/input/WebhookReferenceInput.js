import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const WebhookReferenceFields = {
  id: {
    type: GraphQLString,
    description: 'The public id identifying the webhook (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
  },
  legacyId: {
    type: GraphQLInt,
    description: 'The legacy public id identifying the webhook (ie: 4242)',
  },
};

export const GraphQLWebhookReferenceInput = new GraphQLInputObjectType({
  name: 'WebhookReferenceInput',
  fields: () => WebhookReferenceFields,
});

/**
 * Retrieves a webhook
 *
 * @param {object} input - id of the webhook
 */
export const fetchWebhookWithReference = async input => {
  let notification;
  if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.NOTIFICATION);
    notification = await models.Notification.findByPk(id);
  } else if (input.legacyId) {
    notification = await models.Notification.findByPk(input.legacyId);
  } else {
    throw new Error('Please provide an id');
  }
  if (!notification) {
    throw new NotFound('Webhook Not Found');
  }
  return notification;
};
