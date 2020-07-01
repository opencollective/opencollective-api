import { GraphQLObjectType } from 'graphql';

import { types as collectiveTypes } from '../../../constants/collectives';
import { Account, AccountFields, CollectiveAndFundFields } from '../interface/Account';

export const Collective = new GraphQLObjectType({
  name: 'Collective',
  description: 'This represents a Collective account',
  interfaces: () => [Account],
  isTypeOf: collective => collective.type === collectiveTypes.COLLECTIVE,
  fields: () => {
    return {
      ...AccountFields,
      ...CollectiveAndFundFields,
    };
  },
});
