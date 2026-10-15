import { GraphQLEnumType } from 'graphql';

import { SearchProvider } from '../../../lib/search/types';

export const GraphQLSearchBackend = new GraphQLEnumType({
  name: 'SearchBackend',
  description: 'The backend used to run a search',
  values: {
    [SearchProvider.OPENSEARCH]: {
      value: SearchProvider.OPENSEARCH,
      description: 'OpenSearch cluster (default)',
    },
    [SearchProvider.POSTGRES]: {
      value: SearchProvider.POSTGRES,
      description:
        '[Preview] PostgreSQL: exact totals and numbered pages (up to 50 results per page and offset 5000), search terms up to 200 characters and 12 words.',
    },
  },
});
