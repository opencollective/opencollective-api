import { GraphQLEnumType } from 'graphql';

import { SearchProvider } from '../../../lib/search/types';

export const GraphQLSearchBackend = new GraphQLEnumType({
  name: 'SearchBackend',
  description: 'The backend used to run a search',
  values: {
    OPENSEARCH: {
      value: 'OPENSEARCH',
      description: 'OpenSearch cluster. Searches now run on PostgreSQL.',
      deprecationReason: '2026-11-13: OpenSearch has been removed, searches run on PostgreSQL.',
    },
    [SearchProvider.POSTGRES]: {
      value: SearchProvider.POSTGRES,
      description:
        'PostgreSQL (default): exact totals and numbered pages (up to 50 results per page and offset 5000), search terms up to 200 characters and 12 words.',
    },
  },
});
