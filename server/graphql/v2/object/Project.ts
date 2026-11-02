import { GraphQLObjectType } from 'graphql';

import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';
import { AccountWithHostFields, GraphQLAccountWithHost } from '../interface/AccountWithHost';
import { AccountWithParentFields, GraphQLAccountWithParent } from '../interface/AccountWithParent';

export const GraphQLProject = new GraphQLObjectType({
  name: 'Project',
  description: 'This represents an Project account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithHost, GraphQLAccountWithContributions, GraphQLAccountWithParent],
  isTypeOf: collective => collective.type === 'PROJECT',
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
      ...AccountWithParentFields,
      location: {
        ...AccountFields.location,
        async resolve(project, _, req) {
          // Projects locations are always public
          return req.loaders.Location.byCollectiveId.load(project.id);
        },
      },
    };
  },
});
