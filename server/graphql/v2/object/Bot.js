import { GraphQLObjectType } from 'graphql';

import { AccountFields, GraphQLAccount } from '../interface/Account';

export const GraphQLBot = new GraphQLObjectType({
  name: 'Bot',
  description: 'This represents a Bot account',
  interfaces: () => [GraphQLAccount],
  isTypeOf: collective => collective.type === 'BOT',
  fields: () => {
    return {
      ...AccountFields,
    };
  },
});
