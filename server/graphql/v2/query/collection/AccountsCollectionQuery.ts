import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import { searchCollectivesInDB } from '../../../../lib/search.js';
import { GraphQLAccountCollection } from '../../collection/AccountCollection.js';
import { AccountTypeToModelMapping, GraphQLAccountType, GraphQLCountryISO } from '../../enum/index.js';
import { GraphQLTagSearchOperator } from '../../enum/TagSearchOperator.js';
import { fetchAccountsIdsWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput.js';
import { GraphQLOrderByInput } from '../../input/OrderByInput.js';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection.js';

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
  },
  async resolve(_: void, args): Promise<CollectionReturnType> {
    const { offset, limit } = args;
    const cleanTerm = args.searchTerm?.trim();

    let hostCollectiveIds;
    if (args.host) {
      hostCollectiveIds = await fetchAccountsIdsWithReference(args.host);
    }

    const extraParameters = {
      orderBy: args.orderBy || { field: 'RANK', direction: 'DESC' },
      types: args.type?.length ? args.type.map(value => AccountTypeToModelMapping[value]) : null,
      hostCollectiveIds: hostCollectiveIds,
      parentCollectiveIds: null,
      isHost: args.isHost ? true : null,
      onlyActive: args.isActive ? true : null,
      skipRecentAccounts: args.skipRecentAccounts,
      hasCustomContributionsEnabled: args.hasCustomContributionsEnabled,
      countries: args.country,
      tags: args.tag,
      tagSearchOperator: args.tagSearchOperator,
      includeArchived: args.includeArchived,
    };

    const [accounts, totalCount] = await searchCollectivesInDB(cleanTerm, offset, limit, extraParameters);

    return { nodes: accounts, totalCount, limit, offset };
  },
};

export default AccountsCollectionQuery;
