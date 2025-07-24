import { GraphQLObjectType } from 'graphql';

import { CollectiveType } from '../../../constants/collectives';
import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';
import { AccountWithHostFields, GraphQLAccountWithHost } from '../interface/AccountWithHost';

export const GraphQLCollective = new GraphQLObjectType({
  name: 'Collective',
  description: 'This represents a Collective account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithHost, GraphQLAccountWithContributions],
  isTypeOf: collective => collective.type === CollectiveType.COLLECTIVE,
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
      location: {
        ...AccountFields.location,
        async resolve(collective, _, req) {
          // Collectives locations are always public
          return req.loaders.Location.byCollectiveId.load(collective.id);
        },
      },
    };
  },
});
