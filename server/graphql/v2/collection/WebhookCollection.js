import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import models from '../../../models/index.js';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput.js';
import { CollectionArgs, CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import { GraphQLWebhook } from '../object/Webhook.js';

export const GraphQLWebhookCollection = new GraphQLObjectType({
  name: 'WebhookCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of webhooks',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLWebhook),
      },
    };
  },
});

export const WebhookCollectionArgs = {
  limit: CollectionArgs.limit,
  offset: CollectionArgs.offset,
  account: { type: new GraphQLNonNull(GraphQLAccountReferenceInput) },
};

export const WebhookCollectionResolver = async (args, req) => {
  // Check Pagination arguments
  if (args.limit <= 0) {
    args.limit = CollectionArgs.limit.defaultValue;
  }
  if (args.offset <= 0) {
    args.offset = CollectionArgs.offset.defaultValue;
  }

  // Check and Fetch account
  const account = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });

  const where = { CollectiveId: account.id };

  const { offset, limit } = args;

  const result = await models.Notification.findAndCountAll({
    where,
    limit,
    offset,
  });

  return {
    nodes: result.rows,
    totalCount: result.count,
    limit: args.limit,
    offset: args.offset,
  };
};
