import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import models from '../../../models';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { Collection, CollectionArgs, CollectionFields } from '../interface/Collection';
import { Webhook } from '../object/Webhook';

export const WebhookCollection = new GraphQLObjectType({
  name: 'WebhookCollection',
  interfaces: [Collection],
  description: 'A collection of webhooks',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(Webhook),
      },
    };
  },
});

export const WebhookCollectionArgs = {
  limit: CollectionArgs.limit,
  offset: CollectionArgs.offset,
  account: { type: new GraphQLNonNull(AccountReferenceInput) },
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
