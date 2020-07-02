import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { ActivityType } from '../enum';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { Account } from '../interface/Account';

import { Individual } from './Individual';

export const Activity = new GraphQLObjectType({
  name: 'Activity',
  description: 'An activity describing something that happened on the platform',
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this activity',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.ACTIVITY),
    },
    type: {
      type: new GraphQLNonNull(ActivityType),
      description: 'The type of the activity',
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the ConnectedAccount was created',
    },
    account: {
      type: Account,
      description: 'The account concerned by this activity, if any',
      resolve: async (activity, _, req): Promise<object> => {
        if (activity.CollectiveId) {
          return req.loaders.Collective.byId.load(activity.CollectiveId);
        }
      },
    },
    individual: {
      type: Individual,
      description: 'The person who triggered the action, if any',
      resolve: async (activity, _, req): Promise<object> => {
        if (activity.UserId) {
          const collective = await req.loaders.Collective.byUserId.load(activity.UserId);
          if (!collective.isIncognito) {
            return collective;
          }
        }
      },
    },
  },
});
