import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { Account, AccountFields } from '../interface/Account';
import { AccountWithContributions, AccountWithContributionsFields } from '../interface/AccountWithContributions';
import { AccountWithHost, AccountWithHostFields } from '../interface/AccountWithHost';

import { Collective } from './Collective';

export const Event = new GraphQLObjectType({
  name: 'Event',
  description: 'This represents an Event account',
  interfaces: () => [Account, AccountWithHost, AccountWithContributions],
  isTypeOf: collective => collective.type === 'EVENT',
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
      parent: {
        description: 'The Account hosting this Event',
        type: Account,
        async resolve(event, _, req) {
          if (!event.ParentCollectiveId) {
            return null;
          } else {
            return req.loaders.Collective.byId.load(event.ParentCollectiveId);
          }
        },
      },
      isApproved: {
        description: "Returns whether it's approved by the Fiscal Host",
        type: GraphQLNonNull(GraphQLBoolean),
        async resolve(event, _, req) {
          if (!event.ParentCollectiveId) {
            return false;
          } else {
            const parent = await req.loaders.Collective.byId.load(event.ParentCollectiveId);
            return Boolean(parent && parent.isApproved());
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
      startsAt: {
        description: 'The Event start date and time',
        type: GraphQLDateTime,
      },
      endsAt: {
        description: 'The Event end date and time',
        type: GraphQLDateTime,
      },
    };
  },
});
