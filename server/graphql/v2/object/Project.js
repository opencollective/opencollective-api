import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { Account, AccountFields } from '../interface/Account';
import { AccountWithContributions, AccountWithContributionsFields } from '../interface/AccountWithContributions';
import { AccountWithHost, AccountWithHostFields } from '../interface/AccountWithHost';
import { AccountWithParent, AccountWithParentFields } from '../interface/AccountWithParent';

export const Project = new GraphQLObjectType({
  name: 'Project',
  description: 'This represents an Project account',
  interfaces: () => [Account, AccountWithHost, AccountWithContributions, AccountWithParent],
  isTypeOf: collective => collective.type === 'PROJECT',
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
      ...AccountWithParentFields,
      isApproved: {
        description: "Returns whether it's approved by the Fiscal Host",
        type: GraphQLNonNull(GraphQLBoolean),
        async resolve(event, _, req) {
          if (!event.ParentCollectiveId) {
            return false;
          } else {
            const parent = await req.loaders.Collective.byId.load(event.ParentCollectiveId);
            return parent && parent.isApproved();
          }
        },
      },
    };
  },
});
