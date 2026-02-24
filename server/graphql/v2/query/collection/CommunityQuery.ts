import assert from 'assert';

import type Express from 'express';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { isNil } from 'lodash';
import { QueryTypes, Sequelize } from 'sequelize';

import { parseSearchTerm, sanitizeSearchTermForILike } from '../../../../lib/sql-search';
import { ifStr } from '../../../../lib/utils';
import { Collective, sequelize } from '../../../../models';
import { allowContextPermission, PERMISSION_TYPE } from '../../../common/context-permissions';
import { enforceScope } from '../../../common/scope-check';
import { BadRequest } from '../../../errors';
import { GraphQLAccountCollection } from '../../collection/AccountCollection';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../../enum/AccountType';
import { GraphQLCommunityRelationType } from '../../enum/CommunityRelationType';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import { getAmountRangeQuery, GraphQLAmountRangeInput } from '../../input/AmountRangeInput';
import { GraphQLOrderByInput } from '../../input/OrderByInput';

const DEFAULT_LIMIT = 100;

const buildSearchConditions = (
  searchTerm: string,
): { joinClause: string; whereClause: string; replacements: Record<string, string | number> } => {
  const emptySearchConditions = { joinClause: '', whereClause: '', replacements: {} };
  if (!searchTerm) {
    return emptySearchConditions;
  }

  const parsed = parseSearchTerm(searchTerm);
  if (!parsed.term) {
    return emptySearchConditions;
  }

  if (parsed.type === 'email') {
    return {
      joinClause: `INNER JOIN "Users" u ON u."CollectiveId" = fc.id AND u."deletedAt" IS NULL AND u."email" = LOWER(:searchTerm)`,
      whereClause: '',
      replacements: { searchTerm: parsed.term },
    };
  } else if (parsed.type === 'slug') {
    const sanitizedSlug = sanitizeSearchTermForILike(parsed.term);
    return {
      joinClause: '',
      whereClause: `AND fc."slug" ILIKE :searchTermPattern`,
      replacements: { searchTermPattern: `%${sanitizedSlug}%` },
    };
  } else if (parsed.type === 'id' || parsed.type === 'number') {
    return {
      joinClause: '',
      whereClause: `AND (cas."CollectiveId" = :searchTerm OR cas."FromCollectiveId" = :searchTerm)`,
      replacements: { searchTerm: parsed.term },
    };
  } else {
    const sanitizedTerm = sanitizeSearchTermForILike(parsed.term);
    return {
      joinClause: `LEFT JOIN "Users" u ON u."CollectiveId" = fc.id AND u."deletedAt" IS NULL`,
      whereClause: `AND (fc."name" ILIKE :searchTermPattern OR fc.slug ILIKE :searchTermPattern OR u."email" ILIKE :searchTermPattern)`,
      replacements: { searchTermPattern: `%${sanitizedTerm}%` },
    };
  }
};

type CommunitySummaryArgs = {
  limit: number;
  offset: number;
  type?: string[];
  HostCollectiveId?: number;
  CollectiveId?: number;
  searchTerm?: string;
  relation?: string;
  totalExpendedExpression?: string;
  totalContributedExpression?: string;
};

type CommunitySummaryOptions = {
  orderBy?: {
    field?: string;
    direction?: string;
  };
};

const getHostCommunity = async (replacements: CommunitySummaryArgs, options?: CommunitySummaryOptions) => {
  const isAdmin = 'relation' in replacements && replacements.relation.includes('ADMIN');
  const searchConditions = buildSearchConditions(replacements.searchTerm);

  // Determine if we need to join CommunityHostTransactionsAggregated table
  const needsTransactionsAggregated =
    replacements.totalContributedExpression ||
    replacements.totalExpendedExpression ||
    options?.orderBy?.field === 'TOTAL_CONTRIBUTED' ||
    options?.orderBy?.field === 'TOTAL_EXPENDED';
  const includeCommunityHostTransactionsAggregated = needsTransactionsAggregated;

  const baseQuery = `
    FROM "CommunityActivitySummary" cas
    INNER JOIN "Collectives" fc ON fc.id = cas."FromCollectiveId"
    ${searchConditions.joinClause}
    ${ifStr(isAdmin, `INNER JOIN "Members" m ON m."CollectiveId" = cas."CollectiveId" AND m."MemberCollectiveId" = "FromCollectiveId" AND m.role = 'ADMIN' AND m."deletedAt" IS NULL`)}
    ${ifStr(
      includeCommunityHostTransactionsAggregated,
      `LEFT JOIN "CommunityHostTransactionsAggregated" chta ON chta."FromCollectiveId" = cas."FromCollectiveId" AND chta."HostCollectiveId" = cas."HostCollectiveId"`,
    )}
    WHERE
      fc."deletedAt" IS NULL
      ${ifStr('HostCollectiveId' in replacements, `AND cas."HostCollectiveId" = :HostCollectiveId`)}
      ${ifStr('CollectiveId' in replacements, `AND cas."CollectiveId" = :CollectiveId`)}
      ${ifStr('type' in replacements, `AND fc.type IN (:type)`)}
      ${ifStr('relation' in replacements && replacements.relation.length > 0, `AND cas."relations" @> :relation`)}
      ${ifStr(replacements.totalExpendedExpression, () => `AND ABS(COALESCE(chta."expenseTotalAcc"[ARRAY_UPPER(chta."expenseTotalAcc", 1)], 0))${replacements.totalExpendedExpression}`)}
      ${ifStr(replacements.totalContributedExpression, () => `AND ABS(COALESCE(chta."contributionTotalAcc"[ARRAY_UPPER(chta."contributionTotalAcc", 1)], 0))${replacements.totalContributedExpression}`)}
      ${searchConditions.whereClause}
    `;

  // Build ORDER BY clause based on options
  const orderBy = [];
  const groupBy = ['cas."FromCollectiveId"', 'fc.id'];

  if (options?.orderBy?.field && options?.orderBy?.direction) {
    const direction = options.orderBy.direction.toUpperCase();
    switch (options.orderBy.field) {
      case 'NAME':
        orderBy.push(`fc.name ${direction}`);
        break;
      case 'TOTAL_CONTRIBUTED':
        orderBy.push(
          `ABS(COALESCE(chta."contributionTotalAcc"[ARRAY_UPPER(chta."contributionTotalAcc", 1)], 0)) ${direction}`,
        );
        groupBy.push('chta."contributionTotalAcc"');
        break;
      case 'TOTAL_EXPENDED':
        orderBy.push(`ABS(COALESCE(chta."expenseTotalAcc"[ARRAY_UPPER(chta."expenseTotalAcc", 1)], 0)) ${direction}`);
        groupBy.push('chta."expenseTotalAcc"');
        break;
      default:
        orderBy.push('fc.name ASC');
    }
  } else {
    // Default ordering when filters are applied
    if (replacements.totalExpendedExpression) {
      orderBy.push(`ABS(COALESCE(chta."expenseTotalAcc"[ARRAY_UPPER(chta."expenseTotalAcc", 1)], 0)) DESC`);
      groupBy.push('chta."expenseTotalAcc"');
    }
    if (replacements.totalContributedExpression) {
      orderBy.push(`ABS(COALESCE(chta."contributionTotalAcc"[ARRAY_UPPER(chta."contributionTotalAcc", 1)], 0)) DESC`);
      groupBy.push('chta."contributionTotalAcc"');
    }
    orderBy.push('fc.name ASC');
  }

  const allReplacements = { ...replacements, ...searchConditions.replacements };
  const nodes = () =>
    sequelize.query<Collective>(
      `SELECT fc.* ${baseQuery} GROUP BY ${groupBy.join(', ')} ORDER BY ${orderBy.join(', ')} LIMIT :limit OFFSET :offset`,
      {
        model: Collective,
        mapToModel: true,
        replacements: allReplacements,
      },
    );

  const totalCount = async () =>
    (sequelize as Sequelize)
      .query<{ totalCount: number }>(`SELECT COUNT(DISTINCT fc.id) AS "totalCount" ${baseQuery}`, {
        replacements: allReplacements,
        raw: true,
        type: QueryTypes.SELECT,
        plain: true,
      })
      .then(res => res.totalCount || 0);

  return { nodes, totalCount };
};

const CommunityQuery = {
  description: 'Return accounts that have interacted with a given account or host',
  type: new GraphQLNonNull(GraphQLAccountCollection),
  args: {
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'Account filter',
    },
    host: {
      type: GraphQLAccountReferenceInput,
      description: 'Host context filter',
    },
    type: { type: new GraphQLList(GraphQLAccountType) },
    searchTerm: {
      type: GraphQLString,
      description: 'Admin only. Search by email address or name of a member.',
    },
    relation: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLCommunityRelationType)),
    },
    orderBy: {
      type: GraphQLOrderByInput,
    },
    totalContributed: {
      type: GraphQLAmountRangeInput,
      description: 'Only return accounts that contributed within this amount range',
    },
    totalExpended: {
      type: GraphQLAmountRangeInput,
      description: 'Only return accounts that expended within this amount range',
    },
    limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: DEFAULT_LIMIT },
    offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
  },
  async resolve(_: void, args, req: Express.Request) {
    enforceScope(req, 'host');
    if (isNil(args.limit) || args.limit < 0) {
      args.limit = DEFAULT_LIMIT;
    }
    if (isNil(args.offset) || args.offset < 0) {
      args.offset = 0;
    }
    if (args.limit > DEFAULT_LIMIT && !req.remoteUser?.isRoot()) {
      throw new Error(`Cannot fetch more than ${DEFAULT_LIMIT} members at the same time, please adjust the limit`);
    }

    assert(
      Boolean(args.account) || Boolean(args.host),
      'You must provide either an account or a host to fetch its community',
    );

    const replacements: CommunitySummaryArgs = {
      limit: args.limit,
      offset: args.offset,
    };

    const account = args.account && (await fetchAccountWithReference(args.account, { throwIfMissing: false }));
    const host = args.host && (await fetchAccountWithReference(args.host, { throwIfMissing: false }));
    if (host && account) {
      // TODO: Add exception for accounts that were previously hosted by the host
      assert(
        host.id === account.HostCollectiveId,
        new BadRequest('The account provided is not hosted by the host provided'),
      );
    }
    if (account) {
      assert(
        req.remoteUser?.isAdminOfCollective(host) || req.remoteUser?.isAdminOfCollective(account),
        new BadRequest('Only admins can lookup for members using the "account" argument'),
      );
      replacements.CollectiveId = account.id;
    }
    if (host) {
      assert(
        req.remoteUser?.isAdminOfCollective(host),
        new BadRequest('Only admins can lookup for members using the "host" argument'),
      );
      replacements.HostCollectiveId = host.id;
    }

    const hasCommunityHostTransactionsArgs = args.totalContributed || args.totalExpended;
    if (hasCommunityHostTransactionsArgs) {
      if (args.totalExpended) {
        replacements.totalExpendedExpression = getAmountRangeQuery(args.totalExpended);
      }
      if (args.totalContributed) {
        replacements.totalContributedExpression = getAmountRangeQuery(args.totalContributed);
      }
    }

    if (args.type && args.type.length > 0) {
      replacements.type = args.type.map(value => AccountTypeToModelMapping[value]);
    }
    if (args.relation && args.relation.length > 0) {
      replacements.relation = JSON.stringify(args.relation);
    }
    if (args.searchTerm) {
      if (req.remoteUser?.isAdminOfCollective(account) || req.remoteUser?.isAdminOfCollective(host)) {
        replacements.searchTerm = args.searchTerm;
      } else {
        throw new BadRequest('Only admins can lookup for members using the "searchTerm" argument');
      }
      // TODO: Before returning the result, double check if the remoteUser has access to see the result email
    }

    const { nodes, totalCount } = await getHostCommunity(replacements, { orderBy: args.orderBy });
    const ids: number[] = (await nodes()).map(c => c.id);
    const canSeePrivateLocation = await req.loaders.Collective.canSeePrivateLocation.loadMany(ids);
    const canSeePrivateProfileInfo = await req.loaders.Collective.canSeePrivateProfileInfo.loadMany(ids);
    ids.forEach((id, i) => {
      if (canSeePrivateLocation[i]) {
        allowContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_LOCATION, id);
      }
      if (canSeePrivateProfileInfo[i]) {
        allowContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_PROFILE_INFO, id);
      }
    });
    return { nodes, totalCount, limit: args.limit, offset: args.offset };
  },
};

export default CommunityQuery;
