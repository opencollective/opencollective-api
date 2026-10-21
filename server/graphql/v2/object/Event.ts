import type { Request } from 'express';
import { GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { roles } from '../../../constants';
import type MemberRoles from '../../../constants/roles';
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
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
      ...AccountWithParentFields,
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
      location: {
        ...AccountFields.location,
        async resolve(event, _, req) {
          // Events locations are always public
          return req.loaders.Location.byCollectiveId.load(event.id);
        },
      },
      privateInstructions: {
        type: GraphQLString,
        description: 'Private instructions for the host to be sent to participating users.',
        async resolve(event, _, req: Request) {
          // TODO: `MemberRoles` has no `PARTICIPANT` role, this check is always false (bug reported in PLAN.md)
          if (
            req.remoteUser?.isAdminOfCollective(event) ||
            req.remoteUser?.hasRole((roles as Record<string, MemberRoles>)['PARTICIPANT'], event)
          ) {
            return event.data?.privateInstructions;
          }
        },
      },
    };
  },
});
