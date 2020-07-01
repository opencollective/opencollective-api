import { GraphQLObjectType } from 'graphql';

import { Account, AccountFields, EventAndProjectFields } from '../interface/Account';

import { Fund } from './Fund';

export const Project = new GraphQLObjectType({
  name: 'Project',
  description: 'This represents an Project account',
  interfaces: () => [Account],
  isTypeOf: collective => collective.type === 'PROJECT',
  fields: () => {
    return {
      ...AccountFields,
      ...EventAndProjectFields,
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
    };
  },
});
