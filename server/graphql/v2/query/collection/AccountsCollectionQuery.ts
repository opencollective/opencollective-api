import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { isNil, omitBy } from 'lodash';

import { isElasticSearchConfigured } from '../../../../lib/elastic-search/client';
import { formatIndexNameForElasticSearch } from '../../../../lib/elastic-search/common';
import { ElasticSearchIndexName } from '../../../../lib/elastic-search/constants';
import { elasticSearchGlobalSearch } from '../../../../lib/elastic-search/search';
import { searchCollectivesInDB } from '../../../../lib/sql-search';
import { GraphQLAccountCollection } from '../../collection/AccountCollection';
import { AccountTypeToModelMapping, GraphQLAccountType, GraphQLCountryISO } from '../../enum';
import { GraphQLTagSearchOperator } from '../../enum/TagSearchOperator';
import {
  fetchAccountsIdsWithReference,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../../input/AccountReferenceInput';
import { GraphQLAmountRangeInput } from '../../input/AmountRangeInput';
import { GraphQLOrderByInput } from '../../input/OrderByInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

export const CommonAccountsCollectionQueryArgs = {
  searchTerm: {
    type: GraphQLString,
    description: 'Search accounts related to this term based on name, description, tags, slug, and location',
  },
  tag: {
    type: new GraphQLList(GraphQLString),
    description: 'Only accounts that match these tags',
  },
  tagSearchOperator: {
    type: new GraphQLNonNull(GraphQLTagSearchOperator),
    defaultValue: 'AND',
    description: "Operator to use when searching with tags. Defaults to 'AND'",
  },
  includeArchived: {
    type: GraphQLBoolean,
    description: 'Included collectives which are archived',
  },
  skipGuests: {
    type: GraphQLBoolean,
    description: 'Ignore individual accounts used to make contributions as guests',
    defaultValue: true,
  },
  isActive: {
    type: GraphQLBoolean,
    description: 'Only return "active" accounts with Financial Contributions enabled if true.',
  },
  skipRecentAccounts: {
    type: GraphQLBoolean,
    description: 'Whether to skip recent suspicious accounts (48h)',
    defaultValue: false,
  },
  country: {
    type: new GraphQLList(GraphQLCountryISO),
    description: 'Limit the search to collectives belonging to these countries',
  },
};

const AccountsCollectionQuery = {
  type: new GraphQLNonNull(GraphQLAccountCollection),
  args: {
    ...CollectionArgs,
    ...CommonAccountsCollectionQueryArgs,
    host: {
      type: new GraphQLList(GraphQLAccountReferenceInput),
      description: 'Host hosting the account',
    },
    parent: {
      type: new GraphQLList(GraphQLAccountReferenceInput),
      description: 'Parent Collective hosting the account',
    },
    type: {
      type: new GraphQLList(GraphQLAccountType),
      description:
        'Only return accounts that match these account types (COLLECTIVE, FUND, EVENT, PROJECT, ORGANIZATION or INDIVIDUAL)',
    },
    isHost: {
      type: GraphQLBoolean,
      description: 'Only return Fiscal Hosts accounts if true',
    },
    hasCustomContributionsEnabled: {
      type: GraphQLBoolean,
      description: 'Only accounts with custom contribution (/donate) enabled',
    },
    orderBy: {
      type: GraphQLOrderByInput,
      description:
        'The order of results. Defaults to [RANK, DESC] (or [CREATED_AT, DESC] if `supportedPaymentMethodService` is provided)',
    },
    includeVendorsForHost: {
      type: GraphQLAccountReferenceInput,
      description: 'Include vendors for this host',
    },
    consolidatedBalance: {
      type: GraphQLAmountRangeInput,
      description: 'Filter by the balance of the account and its children accounts (events and projects)',
    },
  },
  async resolve(_: void, args, req): Promise<CollectionReturnType> {
    const { offset, limit } = args;
    const cleanTerm = args.searchTerm?.trim();

    const hostCollectiveIds = args.host && (await fetchAccountsIdsWithReference(args.host));
    const parentCollectiveIds = args.parent && (await fetchAccountsIdsWithReference(args.parent));

    const includeVendorsForHostId = args.includeVendorsForHost
      ? await fetchAccountWithReference(args.includeVendorsForHost).then(({ id }) => id)
      : undefined;

    let preFilteredCollectiveIds: number[];
    if (
      isElasticSearchConfigured() &&
      args.searchTerm &&
      args.tagSearchOperator === 'AND' &&
      !args.includeArchived && // Archived collectives are not indexed in ElasticSearch
      args.skipGuests && // Guests are not indexed in ElasticSearch
      isNil(args.includeVendorsForHost)
    ) {
      // TODO hostCollectiveIds
      // TODO rate limiting
      const elasticSearchResult = await elasticSearchGlobalSearch(
        cleanTerm,
        {
          index: ElasticSearchIndexName.COLLECTIVES,
          indexParams: omitBy(
            {
              types: args.type?.length ? args.type.map(value => AccountTypeToModelMapping[value]) : null,
              isHost: args.isHost,
              tags: args.tag,
              isActive: args.onlyActive ? true : null,
            },
            isNil,
          ),
        },
        {
          skipHighlight: true,
        },
      );

      const bucketResult = elasticSearchResult.aggregations.by_index['buckets'][0];
      const hits = bucketResult.top_hits_by_index.hits.hits;
      preFilteredCollectiveIds = hits.map(hit => hit._source.id);
    }

    const extraParameters = {
      ids: preFilteredCollectiveIds,
      orderBy: args.orderBy || { field: 'RANK', direction: 'DESC' },
      types: args.type?.length ? args.type.map(value => AccountTypeToModelMapping[value]) : null,
      hostCollectiveIds,
      parentCollectiveIds,
      isHost: args.isHost ? true : null,
      onlyActive: args.isActive ? true : null,
      skipRecentAccounts: args.skipRecentAccounts,
      skipGuests: args.skipGuests,
      hasCustomContributionsEnabled: args.hasCustomContributionsEnabled,
      countries: args.country,
      tags: args.tag,
      tagSearchOperator: args.tagSearchOperator,
      includeArchived: args.includeArchived,
      includeVendorsForHostId,
      consolidatedBalance: args.consolidatedBalance,
      isRoot: req.remoteUser?.isRoot() || false,
    };

    const [accounts, totalCount] = await searchCollectivesInDB(cleanTerm, offset, limit, extraParameters);

    return { nodes: accounts, totalCount, limit, offset };
  },
};

export default AccountsCollectionQuery;
