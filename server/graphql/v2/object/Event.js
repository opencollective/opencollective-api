import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';
import { AccountWithHostFields, GraphQLAccountWithHost } from '../interface/AccountWithHost';
import { AccountWithParentFields, GraphQLAccountWithParent } from '../interface/AccountWithParent';

export const GraphQLEvent = new GraphQLObjectType({
  name: 'Event',
  description: 'This represents an Event account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithHost, GraphQLAccountWithContributions, GraphQLAccountWithParent],
  isTypeOf: collective => collective.type === 'EVENT',
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields(),
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
      startsAt: {
        description: 'The Event start date and time',
        type: GraphQLDateTime,
      },
      endsAt: {
        description: 'The Event end date and time',
        type: GraphQLDateTime,
      },
      timezone: {
        description: 'Timezone of the Event (TZ database format, e.g. UTC or Europe/Berlin)',
        type: GraphQLString,
      },
    };
  },
});
