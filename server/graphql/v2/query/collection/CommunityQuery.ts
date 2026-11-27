import assert from 'assert';

import type Express from 'express';
import { GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { type SelectQueryBuilder, sql } from 'kysely';
import { isNil } from 'lodash';

import { roles } from '../../../../constants';
import { CollectiveType } from '../../../../constants/collectives';
import { findCommunitySearchAccountIds } from '../../../../lib/community-search';
import { sqlMissingAddress, sqlMissingLegalName } from '../../../../lib/contributor-info';
import { type DatabaseWithViews, getKysely, kyselyToSequelizeModels } from '../../../../lib/kysely';
import { assertCanSeeAccount } from '../../../../lib/private-accounts';
import SQLQueries from '../../../../lib/queries';
import { isPostgresInteger, parseSearchTerm, sanitizeSearchTermForILike } from '../../../../lib/sql-search';
import { Collective } from '../../../../models';
import { allowContextPermission, PERMISSION_TYPE } from '../../../common/context-permissions';
import { enforceScope, isRemoteUserRoot } from '../../../common/scope-check';
import { BadRequest } from '../../../errors';
import { GraphQLAccountCollection } from '../../collection/AccountCollection';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../../enum/AccountType';
import { GraphQLCommunityRelationType } from '../../enum/CommunityRelationType';
import { GraphQLMissingInformationField, type MissingInformationField } from '../../enum/MissingInformationField';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import { getAmountRangeQuery } from '../../input/AmountRangeInput';
import {
  type AmountRangeWithYearInputType,
  GraphQLAmountRangeWithYearInput,
} from '../../input/AmountRangeWithYearInput';
import { GraphQLOrderByInput } from '../../input/OrderByInput';
import { collectionLimitArg, collectionOffsetArg } from '../../interface/Collection';

const DEFAULT_LIMIT = 100;

type CommunitySummaryArgs = {
  limit: number;
  offset: number;
  type?: CollectiveType[];
  HostCollectiveId?: number;
  CollectiveId?: number;
  searchTerm?: string;
  relation?: string;
  totalExpendedExpression?: string;
  totalContributedExpression?: string;
  /** Calendar year (UTC) the `totalExpended` filter and ordering apply to. All time when not set */
  totalExpendedYear?: number;
  /** Calendar year (UTC) the `totalContributed` filter and ordering apply to. All time when not set */
  totalContributedYear?: number;
  missingInformation?: MissingInformationField[];
  /** Accounts that require a US tax form for the current year but have not received one (`US_TAX_FORM_CURRENT_YEAR`) */
  missingCurrentYearTaxFormAccountIds?: number[];
  /** Accounts that require a US tax form for the previous year but have not received one (`US_TAX_FORM_PREVIOUS_YEAR`) */
  missingPreviousYearTaxFormAccountIds?: number[];
};

/**
 * Query builder with every conditionally-joined table in scope, so dynamic
 * joins and filters typecheck without per-clause casts. Table aliases are
 * mapped to their row types, mirroring what Kysely infers for each join.
 *
 * The base builder is cast to this once: from there on, column names and
 * comparison values are still checked, but the select list is not tracked
 * (the final selection depends on the dynamic joins above).
 */
type CommunitySummaryQueryBuilder = SelectQueryBuilder<
  DatabaseWithViews & {
    cas: DatabaseWithViews['AdminCommunityActivitySummary'];
    fc: DatabaseWithViews['Collectives'];
    u: DatabaseWithViews['Users'];
    m: DatabaseWithViews['Members'];
    // Contributed (credit) and expended (debit) totals are joined separately: they can target different years
    chtsc: DatabaseWithViews['AdminCommunityHostTransactionSummary'];
    chtse: DatabaseWithViews['AdminCommunityHostTransactionSummary'];
  },
  'cas' | 'fc' | 'u' | 'm' | 'chtsc' | 'chtse',
  DatabaseWithViews['AdminCommunityActivitySummary']
>;

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

  const needsContributedTotals = Boolean(
    replacements.totalContributedExpression || options?.orderBy?.field === 'TOTAL_CONTRIBUTED',
  );
  const needsExpendedTotals = Boolean(
    replacements.totalExpendedExpression || options?.orderBy?.field === 'TOTAL_EXPENDED',
  );

  // Text search: where it is faster, look for the matching accounts first (see `findCommunitySearchAccountIds`).
  // `null` means that the regular conditions below apply.
  const searchAccountIds =
    parsed?.term && parsed.type === 'text'
      ? await findCommunitySearchAccountIds(parsed.term.toString(), replacements)
      : null;

  // Determine if we need Users join for search
  const needsUsersJoin =
    parsed?.term &&
    !searchAccountIds &&
    (parsed.type === 'email' ||
      (parsed.type !== 'slug' && parsed.type !== 'id' && parsed.type !== 'number' && parsed.type !== 'publicId'));

  const buildBaseQuery = () => {
    let query = db
      .selectFrom('AdminCommunityActivitySummary as cas')
      .innerJoin('Collectives as fc', join =>
        join.onRef('fc.id', '=', 'cas.FromCollectiveId').on('fc.deletedAt', 'is', null),
      ) as unknown as CommunitySummaryQueryBuilder;

    // Users join for search
    if (parsed?.term) {
      if (parsed.type === 'email') {
        query = query.innerJoin('Users as u', join =>
          join
            .onRef('u.CollectiveId', '=', 'fc.id')
            .on('u.deletedAt', 'is', null)
            .on('u.email', '=', parsed.term.toString().toLowerCase()),
        );
      } else if (needsUsersJoin) {
        query = query.leftJoin('Users as u', join =>
          join.onRef('u.CollectiveId', '=', 'fc.id').on('u.deletedAt', 'is', null),
        );
      }
    }

    // Admin members join
    if (isAdmin) {
      query = query.innerJoin('Members as m', join =>
        join
          .onRef('m.CollectiveId', '=', 'cas.CollectiveId')
          .onRef('m.MemberCollectiveId', '=', 'cas.FromCollectiveId')
          .on('m.role', '=', roles.ADMIN)
          .on('m.deletedAt', 'is', null),
      );
    }

    // Transaction summary joins: all-time view, or yearly view when a year is requested
    const joinTransactionSummary = (alias: 'chtsc' | 'chtse', year: number | undefined) => {
      query = isNil(year)
        ? query.leftJoin(`AdminCommunityHostTransactionSummary as ${alias}`, join =>
            join
              .onRef(`${alias}.FromCollectiveId`, '=', 'cas.FromCollectiveId')
              .onRef(`${alias}.HostCollectiveId`, '=', 'cas.HostCollectiveId')
              .on(`${alias}.kind`, 'is', null),
          )
        : (query.leftJoin(`AdminCommunityHostYearlyTransactionSummary as ${alias}`, join =>
            join
              .onRef(`${alias}.FromCollectiveId`, '=', 'cas.FromCollectiveId')
              .onRef(`${alias}.HostCollectiveId`, '=', 'cas.HostCollectiveId')
              .on(`${alias}.kind`, 'is', null)
              .on(`${alias}.year`, '=', year),
          ) as unknown as CommunitySummaryQueryBuilder);
    };
    if (needsContributedTotals) {
      joinTransactionSummary('chtsc', replacements.totalContributedYear);
    }
    if (needsExpendedTotals) {
      joinTransactionSummary('chtse', replacements.totalExpendedYear);
    }

    // WHERE conditions
    if ('HostCollectiveId' in replacements && replacements.HostCollectiveId !== undefined) {
      query = query.where('cas.HostCollectiveId', '=', replacements.HostCollectiveId);
    }
    if ('CollectiveId' in replacements && replacements.CollectiveId !== undefined) {
      query = query.where('cas.CollectiveId', '=', replacements.CollectiveId);
    }
    if ('type' in replacements && replacements.type && replacements.type.length > 0) {
      query = query.where('fc.type', 'in', replacements.type);
    }
    if ('relation' in replacements && replacements.relation && replacements.relation.length > 0) {
      query = query.where(({ eb }) => eb(sql`cas."relations"`, '@>', sql`${replacements.relation}::jsonb`));
    }
    if (replacements.missingInformation?.length) {
      query = query.where(({ eb, or }) =>
        or(
          replacements.missingInformation.map(field => {
            switch (field) {
              case 'LEGAL_NAME':
                return sqlMissingLegalName('fc');
              case 'ADDRESS':
                return sqlMissingAddress('fc');
              case 'COUNTRY_OF_INCORPORATION':
                return eb.or([
                  sql<boolean>`fc."data" ->> 'taxableCountry' IS NULL`,
                  sql<boolean>`TRIM(fc."data" ->> 'taxableCountry') = ''`,
                ]);
              case 'US_TAX_FORM_CURRENT_YEAR':
                return replacements.missingCurrentYearTaxFormAccountIds?.length
                  ? eb('fc.id', 'in', replacements.missingCurrentYearTaxFormAccountIds)
                  : sql<boolean>`FALSE`;
              case 'US_TAX_FORM_PREVIOUS_YEAR':
                return replacements.missingPreviousYearTaxFormAccountIds?.length
                  ? eb('fc.id', 'in', replacements.missingPreviousYearTaxFormAccountIds)
                  : sql<boolean>`FALSE`;
            }
          }),
        ),
      );
    }
    if (replacements.totalExpendedExpression) {
      query = query.where(
        sql<boolean>`COALESCE(chtse."debitTotal", 0) ${sql.raw(replacements.totalExpendedExpression)}`,
      );
    }
    if (replacements.totalContributedExpression) {
      query = query.where(
        sql<boolean>`COALESCE(chtsc."creditTotal", 0) ${sql.raw(replacements.totalContributedExpression)}`,
      );
    }

    // Search WHERE conditions
    if (parsed?.term) {
      if (parsed.type === 'slug') {
        const sanitizedSlug = sanitizeSearchTermForILike(parsed.term.toString());
        query = query.where('fc.slug', 'ilike', `%${sanitizedSlug}%`);
      } else if (parsed.type === 'id' || parsed.type === 'number') {
        const id = parsed.term;
        if (!isPostgresInteger(id)) {
          query = query.where(sql<boolean>`FALSE`); // Out-of-range or non-integer: no account can have this ID
        } else {
          query = query.where(({ eb, or }) =>
            or([eb('cas.CollectiveId', '=', id), eb('cas.FromCollectiveId', '=', id)]),
          );
        }
      } else if (parsed.type === 'publicId') {
        query = query.where(sql.ref('fc.publicId'), '=', parsed.term);
      } else if (searchAccountIds) {
        // Same accounts as the generic text search below. One array parameter, whatever the number of IDs.
        query = query.where(sql<boolean>`fc.id = ANY(${searchAccountIds}::int[])`);
      } else if (parsed.type !== 'email') {
        // Generic text search (email case is handled by the INNER JOIN above)
        const sanitizedTerm = sanitizeSearchTermForILike(parsed.term.toString());
        const pattern = `%${sanitizedTerm}%`;
        query = query.where(({ eb, or }) =>
          or([eb('fc.name', 'ilike', pattern), eb('fc.slug', 'ilike', pattern), eb('u.email', 'ilike', pattern)]),
        );
      }
    }

    return query;
  };

  // Build ORDER BY / GROUP BY
  // Accounts without a summary row (e.g. no activity in the requested year) count as zero, like in the filters
  const CREDIT_TOTAL_SQL = 'COALESCE(chtsc."creditTotal", 0)';
  const DEBIT_TOTAL_SQL = 'COALESCE(chtse."debitTotal", 0)';
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
          orderBy.push({ field: CREDIT_TOTAL_SQL, direction: dir });
          extraGroupBy.push(CREDIT_TOTAL_SQL);
          break;
        case 'TOTAL_EXPENDED':
          orderBy.push({ field: DEBIT_TOTAL_SQL, direction: dir });
          extraGroupBy.push(DEBIT_TOTAL_SQL);
          break;
        case 'CREATED_AT':
          orderBy.push({ field: 'fc."createdAt"', direction: dir });
          break;
        default:
          orderBy.push({ field: 'fc.name', direction: 'asc' });
      }
    } else {
      if (replacements.totalExpendedExpression) {
        orderBy.push({ field: DEBIT_TOTAL_SQL, direction: 'desc' });
        extraGroupBy.push(DEBIT_TOTAL_SQL);
      }
      if (replacements.totalContributedExpression) {
        orderBy.push({ field: CREDIT_TOTAL_SQL, direction: 'desc' });
        extraGroupBy.push(CREDIT_TOTAL_SQL);
      }
      orderBy.push({ field: 'fc.name', direction: 'asc' });
    }

    return { orderBy, extraGroupBy };
  };

  const { orderBy, extraGroupBy } = buildOrderBy();

  const nodes = async () => {
    let query = buildBaseQuery()
      .selectAll('fc')
      .groupBy(['cas.FromCollectiveId', 'fc.id', ...extraGroupBy.map(f => sql.raw(f))]);

    for (const ob of orderBy) {
      if (ob.direction === 'desc') {
        query = query.orderBy(sql.raw(`${ob.field} DESC NULLS LAST`));
      } else {
        query = query.orderBy(sql.raw(`${ob.field} ASC`));
      }
    }

    // Many people have the same name or the same total: without a last key that is unique, PostgreSQL returns them
    // in an order that depends on the plan, and the same account can come back on two pages.
    query = query.orderBy(sql.raw('fc.id ASC'));

    query = query.limit(replacements.limit).offset(replacements.offset);

    const result = await query.execute();
    return kyselyToSequelizeModels(Collective)(result);
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
    missingInformation: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLMissingInformationField)),
      description: 'Filter accounts missing any of the given information',
    },
    orderBy: {
      type: GraphQLOrderByInput,
    },
    totalContributed: {
      type: GraphQLAmountRangeWithYearInput,
      description:
        'Only return accounts that contributed within this amount range (optionally in a given year). Also scopes the TOTAL_CONTRIBUTED ordering.',
    },
    totalExpended: {
      type: GraphQLAmountRangeWithYearInput,
      description:
        'Only return accounts that were paid (received) within this amount range through expenses (optionally in a given year). Also scopes the TOTAL_EXPENDED ordering.',
    },
    limit: collectionLimitArg(DEFAULT_LIMIT),
    offset: collectionOffsetArg(0),
  },
  async resolve(_: void, args, req: Express.Request) {
    enforceScope(req, 'host');
    if (isNil(args.limit) || args.limit < 0) {
      args.limit = DEFAULT_LIMIT;
    }
    if (isNil(args.offset) || args.offset < 0) {
      args.offset = 0;
    }
    if (args.limit > DEFAULT_LIMIT && !isRemoteUserRoot(req)) {
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
      await assertCanSeeAccount(req, account);
      assert(
        host.id === account.HostCollectiveId,
        new BadRequest('The account provided is not hosted by the host provided'),
      );
      replacements.CollectiveId = account.id;
    }

    const parseTotalsArg = (arg: AmountRangeWithYearInputType | undefined) => {
      if (!arg) {
        return {};
      }
      if (!isNil(arg.year)) {
        assert(Number.isInteger(arg.year) && arg.year >= 1970 && arg.year <= 9999, new BadRequest('Invalid year'));
      }
      return {
        // The year also scopes the ordering, so it is kept even when there is no amount range
        year: arg.year ?? undefined,
        expression: arg.gte || arg.lte ? getAmountRangeQuery(arg) : undefined,
      };
    };
    const totalExpended = parseTotalsArg(args.totalExpended);
    replacements.totalExpendedExpression = totalExpended.expression;
    replacements.totalExpendedYear = totalExpended.year;
    const totalContributed = parseTotalsArg(args.totalContributed);
    replacements.totalContributedExpression = totalContributed.expression;
    replacements.totalContributedYear = totalContributed.year;

    if (args.type && args.type.length > 0) {
      replacements.type = args.type.map(value => AccountTypeToModelMapping[value]);
    }
    if (args.relation && args.relation.length > 0) {
      replacements.relation = JSON.stringify(args.relation);
    }
    if (args.missingInformation && args.missingInformation.length > 0) {
      replacements.missingInformation = args.missingInformation;
      // Accounts required to file a US tax form for the given year that has not been received
      const getAccountIdsMissingTaxForm = async (year: number) =>
        Array.from(
          await SQLQueries.getTaxFormsRequiredForAccounts({ HostCollectiveId: host.id, year, ignoreReceived: true }),
        );
      const currentYear = new Date().getUTCFullYear();
      if (args.missingInformation.includes('US_TAX_FORM_CURRENT_YEAR')) {
        replacements.missingCurrentYearTaxFormAccountIds = await getAccountIdsMissingTaxForm(currentYear);
      }
      if (args.missingInformation.includes('US_TAX_FORM_PREVIOUS_YEAR')) {
        replacements.missingPreviousYearTaxFormAccountIds = await getAccountIdsMissingTaxForm(currentYear - 1);
      }
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
