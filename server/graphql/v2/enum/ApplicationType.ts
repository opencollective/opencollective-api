import { GraphQLEnumType } from 'graphql';

export const GraphQLApplicationType = new GraphQLEnumType({
  name: 'ApplicationType',
  description: 'All application types',
  values: {
    API_KEY: { value: 'apiKey' },
    OAUTH: { value: 'oAuth' },
  },
});
