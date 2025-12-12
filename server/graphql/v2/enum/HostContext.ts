import { GraphQLEnumType } from 'graphql';

const GraphQLHostContext = new GraphQLEnumType({
  name: 'HostContext',
  values: {
    ALL: {
      description: 'Both the Host Organizations internal accounts and Hosted Collectives',
    },
    INTERNAL: {
      description: 'Only the Host Organization (including its projects/events)',
    },
    HOSTED: {
      description: 'Only Hosted Collectives (including their projects/events)',
    },
  },
});

export default GraphQLHostContext;
