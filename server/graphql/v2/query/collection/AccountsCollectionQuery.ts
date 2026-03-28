import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { searchCollectivesInDB } from '../../../../lib/sql-search';
import { BadRequest, Forbidden } from '../../../errors';
import { GraphQLAccountCollection } from '../../collection/AccountCollection';
import { AccountTypeToModelMapping, GraphQLAccountType, GraphQLCountryISO } from '../../enum';
import { GraphQLTagSearchOperator } from '../../enum/TagSearchOperator';
import {
  fetchAccountsIdsWithReference,
  fetchAccountsWithReferences,
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
    onlyOpenToApplications: {
      type: GraphQLBoolean,
      description: 'Must be used with `isHost` to filter hosts that can accept applications',
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
    plan: {
      type: new GraphQLList(GraphQLString),
      description: 'Filter by the plan slug of the account',
    },
    isPlatformSubscriber: {
      type: GraphQLBoolean,
      description: 'Filter accounts that are subscribers to the platform',
    },
    isVerified: {
      type: GraphQLBoolean,
      description: 'Filter accounts that are verified',
    },
    isFirstPartyHost: {
      type: GraphQLBoolean,
      description: 'Filter accounts that are first party hosts',
    },
    lastTransactionFrom: {
      type: GraphQLDateTime,
      description: 'Filter accounts that have a last transaction after this date',
    },
    lastTransactionTo: {
      type: GraphQLDateTime,
      description: 'Filter accounts that have a last transaction before this date',
    },
    includeAccountsWithTransactionsForHost: {
      type: GraphQLBoolean,
      description:
        'When used with `host`, also include accounts that are not currently approved under that host but have ledger rows in `Transactions` with this host as `HostCollectiveId`. Requires the remote user to be an admin of the host.',
    },
  },
  async resolve(_: void, args, req): Promise<CollectionReturnType> {
    const { offset, limit } = args;
    const cleanTerm = args.searchTerm?.trim();

    if (args.includeAccountsWithTransactionsForHost) {
      if (!args.host?.length) {
        throw new BadRequest('`host` is required when `includeAccountsWithTransactionsForHost` is true');
      }
      const hostCollectives = await fetchAccountsWithReferences(args.host, { throwIfMissing: true });
      const canAccess =
        req.remoteUser?.isRoot() ||
        (req.remoteUser && hostCollectives.every(collective => req.remoteUser.isAdminOfCollective(collective)));
      if (!canAccess) {
        throw new Forbidden('You must be an admin of the host to use includeAccountsWithTransactionsForHost');
      }
    }

    const hostCollectiveIds = args.host && (await fetchAccountsIdsWithReference(args.host));
    const parentCollectiveIds = args.parent && (await fetchAccountsIdsWithReference(args.parent));

    const includeVendorsForHostId = args.includeVendorsForHost
      ? await fetchAccountWithReference(args.includeVendorsForHost).then(({ id }) => id)
      : undefined;

    const extraParameters = {
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
      onlyOpenHosts: args.onlyOpenToApplications ? true : null,
      plan: args.plan,
      isPlatformSubscriber: args.isPlatformSubscriber,
      isVerified: args.isVerified,
      isFirstPartyHost: args.isFirstPartyHost,
      lastTransactionFrom: args.lastTransactionFrom,
      lastTransactionTo: args.lastTransactionTo,
      includeAccountsWithTransactionsForHost: args.includeAccountsWithTransactionsForHost === true,
    };

    const [accounts, totalCount] = await searchCollectivesInDB(cleanTerm, offset, limit, extraParameters);

    return { nodes: accounts, totalCount, limit, offset };
  },
};

export default AccountsCollectionQuery;
