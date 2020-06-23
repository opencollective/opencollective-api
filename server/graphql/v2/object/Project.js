import { GraphQLObjectType } from 'graphql';

import { Account, AccountFields } from '../interface/Account';

import { Collective } from './Collective';

export const Project = new GraphQLObjectType({
  name: 'Project',
  description: 'This represents an Project account',
  interfaces: () => [Account],
  isTypeOf: collective => collective.type === 'PROJECT',
  fields: () => {
    return {
      ...AccountFields,
      parent: {
        description: 'The collective hosting this Project',
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
