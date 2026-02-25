import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const WebhookReferenceFields = {
  publicId: {
    type: GraphQLString,
    description: `The resource public id (ie: ${models.Notification.nanoIdPrefix}_xxxxxxxx)`,
  },
  id: {
    type: GraphQLString,
    description: 'The public id identifying the webhook (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    deprecationReason: '2026-02-25: use publicId',
  },
  legacyId: {
    type: GraphQLInt,
    description: 'The legacy public id identifying the webhook (ie: 4242)',
    deprecationReason: '2026-02-25: use publicId',
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
  if (input.publicId) {
    const expectedPrefix = models.Notification.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for Webhook, expected prefix ${expectedPrefix}_`);
    }

    notification = await models.Notification.findOne({ where: { publicId: input.publicId } });
  } else if (input.id) {
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
