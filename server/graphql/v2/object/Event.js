import { GraphQLObjectType } from 'graphql';

import { Account, AccountFields, EventAndProjectFields } from '../interface/Account';

import { Collective } from './Collective';

export const Event = new GraphQLObjectType({
  name: 'Event',
  description: 'This represents an Event account',
  interfaces: () => [Account],
  isTypeOf: collective => collective.type === 'EVENT',
  fields: () => {
    return {
      ...AccountFields,
      ...EventAndProjectFields,
      parent: {
        description: 'The Collective hosting this Event',
        type: Collective,
        async resolve(event, _, req) {
          if (!event.ParentCollectiveId) {
            return null;
          } else {
            return req.loaders.Collective.byId.load(event.ParentCollectiveId);
          }
        },
      },
      parentCollective: {
        description: 'The Collective hosting this Event',
        deprecationReason: '2020/07/01 - Use parent instead.',
        type: Collective,
        async resolve(event, _, req) {
          if (!event.ParentCollectiveId) {
            return null;
          } else {
            return req.loaders.Collective.byId.load(event.ParentCollectiveId);
          }
        },
      },
    };
  },
});
