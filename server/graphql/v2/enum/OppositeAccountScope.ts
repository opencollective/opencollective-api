import { GraphQLEnumType } from 'graphql';

const GraphQLOppositeAccountScope = new GraphQLEnumType({
  name: 'OppositeAccountScope',
  description:
    'Filters orders based on whether the opposite account (the other side of the order) is internal or external. For fiscal hosts, internal means within the same host. For regular accounts, internal means within the account and its children (events/projects).',
  values: {
    INTERNAL: {
      description:
        'Only orders where the opposite account is within the same scope (same fiscal host, or same account hierarchy)',
    },
    EXTERNAL: {
      description: 'Only orders where the opposite account is outside the scope',
    },
  },
});

export default GraphQLOppositeAccountScope;
