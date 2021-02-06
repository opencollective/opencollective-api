import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { Account, AccountFields } from '../interface/Account';
import { AccountWithContributions, AccountWithContributionsFields } from '../interface/AccountWithContributions';
import { AccountWithHost, AccountWithHostFields } from '../interface/AccountWithHost';

import { Fund } from './Fund';

export const Project = new GraphQLObjectType({
  name: 'Project',
  description: 'This represents an Project account',
  interfaces: () => [Account, AccountWithHost, AccountWithContributions],
  isTypeOf: collective => collective.type === 'PROJECT',
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
      parent: {
        description: 'The Fund hosting this Project',
        type: Fund,
        async resolve(project, _, req) {
          if (!project.ParentCollectiveId) {
            return null;
          } else {
            return req.loaders.Collective.byId.load(project.ParentCollectiveId);
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
            return parent && parent.isApproved();
          }
        },
      },
    };
  },
});
