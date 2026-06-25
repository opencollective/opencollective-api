import { GraphQLObjectType } from 'graphql';

import { CollectiveType } from '../../../constants/collectives';
import { AccountFields, GraphQLAccount } from '../interface/Account';

export const GraphQLPlatform = new GraphQLObjectType({
  name: 'Platform',
  description:
    'This represents a Platform account: a global, host-less Open Collective platform-owned account (currently the "platform-tips" account that holds platform tips on behalf of the platform).',
  interfaces: () => [GraphQLAccount],
  isTypeOf: collective => collective.type === CollectiveType.PLATFORM,
  fields: () => {
    return {
      ...AccountFields,
    };
  },
});
