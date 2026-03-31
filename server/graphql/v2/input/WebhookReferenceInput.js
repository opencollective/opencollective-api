import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const WebhookReferenceFields = {
  id: {
    type: GraphQLString,
    description: `The public id identifying the webhook (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re, ${EntityShortIdPrefix.ActivitySubscription}_xxxxxxxx)`,
  },
  legacyId: {
    type: GraphQLInt,
    description: 'The legacy public id identifying the webhook (ie: 4242)',
    deprecationReason: '2026-02-25: use id',
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
  if (isEntityPublicId(input.id, EntityShortIdPrefix.ActivitySubscription)) {
    notification = await models.ActivitySubscription.findOne({ where: { publicId: input.id } });
  } else if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.ACTIVITY_SUBSCRIPTION);
    notification = await models.ActivitySubscription.findByPk(id);
  } else if (input.legacyId) {
    notification = await models.ActivitySubscription.findByPk(input.legacyId);
  } else {
    throw new Error('Please provide an id');
  }
  if (!notification) {
    throw new NotFound('Webhook Not Found');
  }
  return notification;
};
