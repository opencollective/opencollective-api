import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityMigratedToPublicId } from '../../../lib/permalink/entity-map';
import { GraphQLActivityType } from '../enum';
import { idEncode } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';
import URL from '../scalar/URL';

export const GraphQLWebhook = new GraphQLObjectType({
  name: 'Webhook',
  description: 'An webhook attached to an account',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve(activitySubscription) {
        if (isEntityMigratedToPublicId(EntityShortIdPrefix.ActivitySubscription, activitySubscription.createdAt)) {
          return activitySubscription.publicId;
        } else {
          return idEncode(activitySubscription.id, 'activitySubscription');
        }
      },
    },
    publicId: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The resource public id (ie: ${EntityShortIdPrefix.ActivitySubscription}_xxxxxxxx)`,
    },
    legacyId: {
      type: new GraphQLNonNull(GraphQLInt),
      deprecationReason: '2026-02-25: use publicId',
      resolve(activitySubscription) {
        return activitySubscription.id;
      },
    },
    activityType: {
      type: GraphQLActivityType,
      resolve(activitySubscription) {
        return activitySubscription.type;
      },
    },
    webhookUrl: {
      type: URL,
      resolve(activitySubscription) {
        return activitySubscription.webhookUrl;
      },
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      resolve(activitySubscription, args, req) {
        if (activitySubscription.CollectiveId) {
          return req.loaders.Collective.byId.load(activitySubscription.CollectiveId);
        }
      },
    },
  }),
});
