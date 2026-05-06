import assert from 'assert';

import type Express from 'express';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { sql } from 'kysely';
import { isNil } from 'lodash';

import { getKysely, kyselyToSequelizeModels } from '../../../../lib/kysely';
import { parseSearchTerm, sanitizeSearchTermForILike } from '../../../../lib/sql-search';
import { Collective } from '../../../../models';
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
  const db = getKysely();
  const isAdmin = 'relation' in replacements && replacements.relation?.includes('ADMIN');
  const searchTerm = replacements.searchTerm;
  const parsed = searchTerm ? parseSearchTerm(searchTerm) : null;

  const needsTransactionsAggregated =
    replacements.totalContributedExpression ||
    replacements.totalExpendedExpression ||
    options?.orderBy?.field === 'TOTAL_CONTRIBUTED' ||
    options?.orderBy?.field === 'TOTAL_EXPENDED';

  // Determine if we need Users join for search
  const needsUsersJoin =
    parsed?.term &&
    (parsed.type === 'email' ||
      (parsed.type !== 'slug' && parsed.type !== 'id' && parsed.type !== 'number' && parsed.type !== 'publicId'));

  const buildBaseQuery = () => {
    let query = db
      .selectFrom('AdminCommunityActivitySummary as cas')
      .innerJoin('Collectives as fc', join =>
        join.onRef('fc.id', '=', 'cas.FromCollectiveId').on('fc.deletedAt', 'is', null),
      );

    // Users join for search
    if (parsed?.term) {
      if (parsed.type === 'email') {
        query = query.innerJoin('Users as u', join =>
          join
            .onRef('u.CollectiveId', '=', 'fc.id')
            .on('u.deletedAt', 'is', null)
            .on('u.email', '=', parsed.term.toString().toLowerCase()),
        ) as any;
      } else if (needsUsersJoin) {
        query = query.leftJoin('Users as u', join =>
          join.onRef('u.CollectiveId', '=', 'fc.id').on('u.deletedAt', 'is', null),
        ) as any;
      }
    }

    // Admin members join
    if (isAdmin) {
      query = query.innerJoin('Members as m', join =>
        join
          .onRef('m.CollectiveId', '=', 'cas.CollectiveId')
          .onRef('m.MemberCollectiveId', '=', 'cas.FromCollectiveId' as any)
          .on('m.role' as any, '=', 'ADMIN')
          .on('m.deletedAt', 'is', null),
      ) as any;
    }

    // CommunityHostTransactionSummary join
    if (needsTransactionsAggregated) {
      query = query.leftJoin('AdminCommunityHostTransactionSummary as chts', join =>
        join
          .onRef('chts.FromCollectiveId', '=', 'cas.FromCollectiveId')
          .onRef('chts.HostCollectiveId', '=', 'cas.HostCollectiveId')
          .on('chts.kind', 'is', null),
      ) as any;
    }

    // WHERE conditions
    if ('HostCollectiveId' in replacements && replacements.HostCollectiveId !== undefined) {
      query = query.where('cas.HostCollectiveId', '=', replacements.HostCollectiveId) as any;
    }
    if ('CollectiveId' in replacements && replacements.CollectiveId !== undefined) {
      query = query.where('cas.CollectiveId', '=', replacements.CollectiveId) as any;
    }
    if ('type' in replacements && replacements.type && replacements.type.length > 0) {
      query = query.where('fc.type' as any, 'in', replacements.type as any) as any;
    }
    if ('relation' in replacements && replacements.relation && replacements.relation.length > 0) {
      query = query.where(({ eb }) => eb(sql`cas."relations"`, '@>', sql`${replacements.relation}::jsonb`)) as any;
    }
    if (replacements.totalExpendedExpression) {
      query = query.where(sql<boolean>`chts."debitTotal" ${sql.raw(replacements.totalExpendedExpression)}`) as any;
    }
    if (replacements.totalContributedExpression) {
      query = query.where(sql<boolean>`chts."creditTotal" ${sql.raw(replacements.totalContributedExpression)}`) as any;
    }

    // Search WHERE conditions
    if (parsed?.term) {
      if (parsed.type === 'slug') {
        const sanitizedSlug = sanitizeSearchTermForILike(parsed.term.toString());
        query = query.where('fc.slug', 'ilike', `%${sanitizedSlug}%`) as any;
      } else if (parsed.type === 'id' || parsed.type === 'number') {
        query = query.where(({ eb, or }) =>
          or([
            eb('cas.CollectiveId' as any, '=', Number(parsed.term)),
            eb('cas.FromCollectiveId' as any, '=', Number(parsed.term)),
          ]),
        ) as any;
      } else if (parsed.type === 'publicId') {
        query = query.where('fc.publicId' as any, '=', parsed.term) as any;
      } else if (parsed.type !== 'email') {
        // Generic text search (email case is handled by the INNER JOIN above)
        const sanitizedTerm = sanitizeSearchTermForILike(parsed.term.toString());
        const pattern = `%${sanitizedTerm}%`;
        query = query.where(({ eb, or }) =>
          or([
            eb('fc.name' as any, 'ilike', pattern),
            eb('fc.slug' as any, 'ilike', pattern),
            eb('u.email' as any, 'ilike', pattern),
          ]),
        ) as any;
      }
    }

    return query;
  };

  // Build ORDER BY / GROUP BY
  const buildOrderBy = () => {
    const orderBy: Array<{ field: string; direction: 'asc' | 'desc' }> = [];
    const extraGroupBy: string[] = [];

    if (options?.orderBy?.field && options?.orderBy?.direction) {
      const dir = options.orderBy.direction.toLowerCase() as 'asc' | 'desc';
      switch (options.orderBy.field) {
        case 'NAME':
          orderBy.push({ field: 'fc.name', direction: dir });
          break;
        case 'TOTAL_CONTRIBUTED':
          orderBy.push({ field: 'chts."creditTotal"', direction: dir });
          extraGroupBy.push('chts."creditTotal"');
          break;
        case 'TOTAL_EXPENDED':
          orderBy.push({ field: 'chts."debitTotal"', direction: dir });
          extraGroupBy.push('chts."debitTotal"');
          break;
        case 'CREATED_AT':
          orderBy.push({ field: 'fc."createdAt"', direction: dir });
          break;
        default:
          orderBy.push({ field: 'fc.name', direction: 'asc' });
      }
    } else {
      if (replacements.totalExpendedExpression) {
        orderBy.push({ field: 'chts."debitTotal"', direction: 'desc' });
        extraGroupBy.push('chts."debitTotal"');
      }
      if (replacements.totalContributedExpression) {
        orderBy.push({ field: 'chts."creditTotal"', direction: 'desc' });
        extraGroupBy.push('chts."creditTotal"');
      }
      orderBy.push({ field: 'fc.name', direction: 'asc' });
    }

    return { orderBy, extraGroupBy };
  };

  const { orderBy, extraGroupBy } = buildOrderBy();

  const nodes = async () => {
    let query = buildBaseQuery()
      .select(sql`fc.*` as any)
      .groupBy(['cas.FromCollectiveId', 'fc.id', ...extraGroupBy.map(f => sql.raw(f))]);

    for (const ob of orderBy) {
      if (ob.direction === 'desc') {
        query = query.orderBy(sql.raw(`${ob.field} DESC NULLS LAST`)) as any;
      } else {
        query = query.orderBy(sql.raw(`${ob.field} ASC`)) as any;
      }
    }

    query = query.limit(replacements.limit).offset(replacements.offset);

    const result = await query.execute();
    return kyselyToSequelizeModels(Collective)(result as any[]);
  };

  const totalCount = async () => {
    const result = await buildBaseQuery()
      .select(sql<number>`COUNT(DISTINCT fc.id)`.as('totalCount'))
      .executeTakeFirst();
    return Number(result?.totalCount) || 0;
  };

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
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
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

    const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
    assert(
      req.remoteUser?.isAdminOfCollective(host),
      new BadRequest('Only admins of the host can access the community endpoint'),
    );

    const replacements: CommunitySummaryArgs = {
      limit: args.limit,
      offset: args.offset,
      HostCollectiveId: host.id,
    };

    const account = args.account && (await fetchAccountWithReference(args.account, { throwIfMissing: false }));
    if (account) {
      assert(
        host.id === account.HostCollectiveId,
        new BadRequest('The account provided is not hosted by the host provided'),
      );
      replacements.CollectiveId = account.id;
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
      replacements.searchTerm = args.searchTerm;
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
