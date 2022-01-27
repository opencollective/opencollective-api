import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { Account, AccountFields } from '../interface/Account';
import { AccountWithContributions, AccountWithContributionsFields } from '../interface/AccountWithContributions';
import { AccountWithHost, AccountWithHostFields } from '../interface/AccountWithHost';
import { AccountWithParent, AccountWithParentFields } from '../interface/AccountWithParent';

import { Collective } from './Collective';

export const Event = new GraphQLObjectType({
  name: 'Event',
  description: 'This represents an Event account',
  interfaces: () => [Account, AccountWithHost, AccountWithContributions, AccountWithParent],
  isTypeOf: collective => collective.type === 'EVENT',
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
      ...AccountWithParentFields,
      isApproved: {
        description: "Returns whether it's approved by the Fiscal Host",
        type: new GraphQLNonNull(GraphQLBoolean),
        async resolve(event, _, req) {
          if (!event.ParentCollectiveId) {
            return false;
          } else {
            const parent = await req.loaders.Collective.byId.load(event.ParentCollectiveId);
            return Boolean(parent?.isApproved());
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
