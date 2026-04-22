import assert from 'assert';

import config from 'config';
import type express from 'express';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLNonEmptyString } from 'graphql-scalars';
import { sql } from 'kysely';
import { compact, find, get, uniq } from 'lodash';
import moment from 'moment';
import { QueryTypes } from 'sequelize';

import { roles } from '../../../constants';
import { CollectiveType } from '../../../constants/collectives';
import expenseType from '../../../constants/expense-type';
import OrderStatuses from '../../../constants/order-status';
import POLICIES from '../../../constants/policies';
import { TransactionKind } from '../../../constants/transaction-kind';
import { TransactionTypes } from '../../../constants/transactions';
import { FEATURE, hasFeature } from '../../../lib/allowed-features';
import { getKysely, kyselyToSequelizeModels } from '../../../lib/kysely';
import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import { getPolicy } from '../../../lib/policies';
import sequelize from '../../../lib/sequelize';
import { buildKyselySearchConditions, buildSearchConditions } from '../../../lib/sql-search';
import { parseToBoolean } from '../../../lib/utils';
import models, { Collective, ConnectedAccount, Op, TransactionsImportRow } from '../../../models';
import { AccountingCategoryAppliesTo } from '../../../models/AccountingCategory';
import { AccountingCategoryRule } from '../../../models/AccountingCategoryRule';
import { PayoutMethodTypes } from '../../../models/PayoutMethod';
import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { checkRemoteUserCanUseHost, checkRemoteUserCanUseTransactions, checkScope } from '../../common/scope-check';
import { Unauthorized } from '../../errors';
import { GraphQLAccountCollection } from '../collection/AccountCollection';
import { GraphQLAccountingCategoryCollection } from '../collection/AccountingCategoryCollection';
import { GraphQLTransactionsImportRowCollection } from '../collection/GraphQLTransactionsImportRow';
import { GraphQLTransactionsImportsCollection } from '../collection/TransactionsImportsCollection';
import { GraphQLVendorCollection } from '../collection/VendorCollection';
import { GraphQLPaymentMethodLegacyType, GraphQLPayoutMethodType } from '../enum';
import { GraphQLAccountingCategoryKind } from '../enum/AccountingCategoryKind';
import { GraphQLLegalDocumentType } from '../enum/LegalDocumentType';
import { GraphQLManualPaymentProviderType } from '../enum/ManualPaymentProviderType';
import { PaymentMethodLegacyTypeEnum } from '../enum/PaymentMethodLegacyType';
import { GraphQLTimeUnit } from '../enum/TimeUnit';
import { GraphQLTransactionsImportRowStatus, TransactionsImportRowStatus } from '../enum/TransactionsImportRowStatus';
import { GraphQLTransactionsImportStatus } from '../enum/TransactionsImportStatus';
import { GraphQLTransactionsImportType } from '../enum/TransactionsImportType';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import {
  fetchAccountsIdsWithReference,
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput } from '../input/AmountInput';
import { GraphQLAmountRangeInput } from '../input/AmountRangeInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../input/ChronologicalOrderInput';
import { GraphQLOrderByInput } from '../input/OrderByInput';
import { GraphQLTransactionsImportRowOrderInput } from '../input/TransactionsImportRowOrderInput';
import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';
import {
  AccountWithPlatformSubscriptionFields,
  GraphQLAccountWithPlatformSubscription,
} from '../interface/AccountWithPlatformSubscription';
import { CollectionArgs, getCollectionArgs } from '../interface/Collection';

import { GraphQLContributionAccountingCategoryRule } from './AccountingCategory';
import { GraphQLContributionStats } from './ContributionStats';
import { GraphQLExpenseStats } from './ExpenseStats';
import { GraphQLHost } from './Host';
import { GraphQLManualPaymentProvider } from './ManualPaymentProvider';
import { GraphQLTransactionsImportStats } from './OffPlatformTransactionsStats';
import { GraphQLStripeConnectedAccount } from './StripeConnectedAccount';

const getFilterDateRange = (startDate, endDate) => {
  let dateRange;
  if (startDate && endDate) {
    dateRange = { [Op.gte]: startDate, [Op.lt]: endDate };
  } else if (startDate) {
    dateRange = { [Op.gte]: startDate };
  } else if (endDate) {
    dateRange = { [Op.lt]: endDate };
  }
  return dateRange;
};

const getNumberOfDays = (startDate, endDate, host) => {
  const momentStartDate = startDate && moment(startDate);
  const momentCreated = moment(host.createdAt);
  const momentFrom = momentStartDate?.isAfter(momentCreated) ? momentStartDate : momentCreated; // We bound the date range to the host creation date
  const momentTo = moment(endDate || undefined); // Defaults to Today
  return Math.abs(momentFrom.diff(momentTo, 'days'));
};

export const getOrganizationFields = () => ({
  ...AccountFields,
  ...AccountWithContributionsFields,
  ...AccountWithPlatformSubscriptionFields,
  email: {
    type: GraphQLString,
    deprecationReason: '2022-07-18: This field is deprecated and will return null',
    resolve: () => null,
  },
  location: {
    ...AccountFields.location,
    description: `
      Address. This field is public for hosts, otherwise:
        - Users can see the addresses of the collectives they're admin of; if they are not an admin they can only see the country that the org belong to.
        - Hosts can see the address of organizations submitting expenses to their collectives.
    `,
    async resolve(organization, _, req) {
      const location = await req.loaders.Location.byCollectiveId.load(organization.id);
      const canSeeLocation =
        (await organization.hasHosting) || // Hosts locations are always public
        (checkScope(req, 'account') &&
          (req.remoteUser?.isAdmin(organization.id) ||
            getContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_LOCATION, organization.id)));

      if (canSeeLocation) {
        return location;
      } else {
        return { country: location?.country };
      }
    },
  },
  host: {
    type: GraphQLHost,
    description: 'If the organization is a host account, this will return the matching Host object',
    resolve(collective) {
      if (collective.hasMoneyManagement) {
        return collective;
      }
    },
  },
  hasMoneyManagement: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Returns whether the account has money management activated.',
    resolve(collective) {
      return collective.hasMoneyManagement;
    },
  },
  hasHosting: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Returns whether the account has hosting activated.',
    resolve(collective) {
      return collective.hasHosting;
    },
  },
  canBeVendorOf: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description:
      'Returns whether this organization can be a vendor of the specified host. This checks if the organization only transacted with this host and all its admins are also admins of the host.',
    args: {
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The host account to check against',
      },
    },
    async resolve(organization, args, req) {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to check vendor eligibility');
      }

      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });

      // Query to check if this organization meets the criteria to be a vendor
      const query = `
        WITH hostadmins AS (
          SELECT m."MemberCollectiveId", u."id" as "UserId"
          FROM "Members" m
          INNER JOIN "Users" u ON m."MemberCollectiveId" = u."CollectiveId"
          WHERE m."CollectiveId" = :hostid AND m."deletedAt" IS NULL AND m.role = 'ADMIN'
        ), org AS (
          SELECT c.id, ARRAY_AGG(DISTINCT m."MemberCollectiveId") as "admins", ARRAY_AGG(DISTINCT t."HostCollectiveId") as hosts, c."CreatedByUserId"
          FROM "Collectives" c
          LEFT JOIN "Members" m ON c.id = m."CollectiveId" AND m."deletedAt" IS NULL AND m.role = 'ADMIN'
          LEFT JOIN "Transactions" t ON c.id = t."FromCollectiveId" AND t."deletedAt" IS NULL
          WHERE c."deletedAt" IS NULL
            AND c.id = :orgid
            AND c.type = 'ORGANIZATION'
            AND c."HostCollectiveId" IS NULL
          GROUP BY c.id
        )
        SELECT EXISTS(
          SELECT 1
          FROM "org" o
          WHERE
            (
              o."admins" <@ ARRAY(SELECT "MemberCollectiveId" FROM hostadmins)
                OR (
                  o."CreatedByUserId" IN (
                    SELECT "UserId"
                    FROM hostadmins
                  )
                  AND o."admins" = ARRAY[null]::INTEGER[]
                )
            )
            AND o."hosts" IN (ARRAY[:hostid], ARRAY[null]::INTEGER[])
        ) as "canBeVendor";
      `;

      const result = await sequelize.query<{
        canBeVendor: boolean;
      }>(query, {
        replacements: {
          hostid: host.id,
          orgid: organization.id,
        },
        type: QueryTypes.SELECT,
      });

      return result[0]?.canBeVendor || false;
    },
  },
  vendors: {
    type: new GraphQLNonNull(GraphQLVendorCollection),
    description: 'Returns a list of vendors that works with this host',
    args: {
      ...getCollectionArgs({ limit: 100, offset: 0 }),
      forAccount: {
        type: GraphQLAccountReferenceInput,
        description: 'Rank vendors based on their relationship with this account',
      },
      visibleToAccounts: {
        type: new GraphQLList(GraphQLAccountReferenceInput),
        description: 'Only returns vendors that are visible to the given accounts',
      },
      isArchived: {
        type: GraphQLBoolean,
        description: 'Filter on archived vendors',
      },
      searchTerm: {
        type: GraphQLString,
        description: 'Search vendors related to this term based on name, description, tags, slug, and location',
      },
      totalContributed: {
        type: GraphQLAmountRangeInput,
        description: 'Only return accounts that contributed within this amount range',
      },
      totalExpended: {
        type: GraphQLAmountRangeInput,
        description: 'Only return accounts that expended within this amount range',
      },
      orderBy: {
        type: GraphQLOrderByInput,
        description: 'Order of the results',
      },
    },
    async resolve(host: Collective, args, req: express.Request) {
      // Check if user is admin of the Host
      const publicVendorPolicy = await getPolicy(host, POLICIES.EXPENSE_PUBLIC_VENDORS);
      const isAdmin = req.remoteUser?.isAdminOfCollective(host);
      if (!publicVendorPolicy && !isAdmin) {
        return { nodes: [], totalCount: 0, limit: args.limit, offset: args.offset };
      }

      const db = getKysely();
      let query = db
        .with('Vendors', db =>
          db
            .selectFrom('Collectives')
            .leftJoin('CommunityHostTransactionSummary', join =>
              join
                .onRef('CommunityHostTransactionSummary.FromCollectiveId', '=', 'Collectives.id')
                .on('CommunityHostTransactionSummary.HostCollectiveId', '=', host.id)
                .on('CommunityHostTransactionSummary.kind', 'is', null),
            )
            .where('ParentCollectiveId', '=', host.id)
            .where('type', '=', CollectiveType.VENDOR)
            .where('deactivatedAt', args.isArchived ? 'is not' : 'is', null)
            .where('deletedAt', 'is', null)
            .selectAll('Collectives')
            .select(({ ref }) => [
              sql<number>`ABS(COALESCE(${ref('CommunityHostTransactionSummary.debitTotal')}, 0))`.as('totalExpended'),
              sql<number>`ABS(COALESCE(${ref('CommunityHostTransactionSummary.creditTotal')}, 0))`.as(
                'totalContributed',
              ),
            ]),
        )
        .selectFrom('Vendors');

      query = query.where('ParentCollectiveId', '=', host.id).where('type', '=', CollectiveType.VENDOR);

      // Total Expended Filtering
      query = query
        .$if(args.totalExpended?.gte, q =>
          q.where('totalExpended', '>=', getValueInCentsFromAmountInput(args.totalExpended.gte)),
        )
        .$if(args.totalExpended?.lte, q =>
          q.where(({ or, eb }) =>
            or([
              eb('totalExpended', '<=', getValueInCentsFromAmountInput(args.totalExpended.lte)),
              eb('totalExpended', 'is', null),
            ]),
          ),
        );

      // Total Contributed Filtering
      query = query
        .$if(args.totalContributed?.gte, q =>
          q.where('totalContributed', '>=', getValueInCentsFromAmountInput(args.totalContributed.gte)),
        )
        .$if(args.totalContributed?.lte, q =>
          q.where(({ or, eb }) =>
            or([
              eb('totalContributed', '<=', getValueInCentsFromAmountInput(args.totalContributed.lte)),
              eb('totalContributed', 'is', null),
            ]),
          ),
        );

      // Search Term
      const textFields = ['name', 'description', 'longDescription'];
      if (isAdmin) {
        textFields.push('legalName');
      }
      query = query.$if(
        args.searchTerm,
        buildKyselySearchConditions(args.searchTerm, {
          idFields: ['id'],
          slugFields: ['slug'],
          textFields,
          publicIdFields: [{ field: ['publicId'], prefix: EntityShortIdPrefix.Collective }],
        }),
      );

      // Here we'll conditionally store some selects and orders so we don't compromise the countQuery later down the line.
      const selects: Array<Parameters<typeof query.select>[0]> = [];
      const order = [];

      // Conditionally filter or select expenseCount if args.forAccount exists
      if (args.forAccount) {
        const account = await fetchAccountWithReference(args.forAccount, {
          throwIfMissing: true,
          loaders: req.loaders,
        });
        if (!isAdmin) {
          query = query.where(({ exists, selectFrom }) =>
            exists(
              selectFrom('Expenses')
                .whereRef('Expenses.FromCollectiveId', '=', 'Vendors.id')
                .where('Expenses.deletedAt', 'is', null)
                .where('Expenses.status', '=', 'PAID')
                .where('Expenses.CollectiveId', '=', account.id)
                .limit(1),
            ),
          );
        } else {
          // Adding conditional selects is not recommended, do not use this elsewhere.
          selects.push(({ selectFrom }) =>
            selectFrom('Expenses')
              .select(({ fn }) => fn.count<number>('Expenses.id').as('expenseCount'))
              .whereRef('Expenses.FromCollectiveId', '=', 'Vendors.id')
              .where('Expenses.deletedAt', 'is', null)
              .where('Expenses.status', '=', 'PAID')
              .where('Expenses.CollectiveId', '=', account.id)
              .as('expenseCount'),
          );
          order.push([eb => eb.ref('expenseCount'), 'desc']);
        }
      }

      // It is fine to fork execution using conditionals because we're just changing WHERE conditionals
      if (args.visibleToAccounts?.length > 0) {
        const visibleToAccountIds = await fetchAccountsIdsWithReference(args.visibleToAccounts, {
          throwIfMissing: true,
        });
        const parentAccounts = await Collective.findAll({
          where: {
            id: visibleToAccountIds,
            ParentCollectiveId: { [Op.ne]: null },
          },
          attributes: ['ParentCollectiveId'],
        });
        const accountIds = uniq(
          compact([...visibleToAccountIds, ...parentAccounts.map(acc => acc.ParentCollectiveId)]),
        );

        query = query.where(
          () => sql`
              data#>'{visibleToAccountIds}' IS NULL
              OR data#>'{visibleToAccountIds}' = '[]'::jsonb
              OR data#>'{visibleToAccountIds}' = 'null'::jsonb
              OR (
                jsonb_typeof(data#>'{visibleToAccountIds}')='array'
                AND
                EXISTS (
                  SELECT v FROM (
                    SELECT v::text::int FROM (SELECT jsonb_array_elements(data#>'{visibleToAccountIds}') as v)
                  ) WHERE v = ANY(ARRAY[${sql.join(accountIds)}]::int[])
                )
              )
          `,
        );
      }

      // Forking NodeQuery and CountQuery because they're only subjected to the same WHERE conditions
      let nodeQuery = query.selectAll('Vendors').select('totalContributed').select('totalExpended');
      if (selects.length > 0) {
        nodeQuery = nodeQuery.select(selects);
      }
      // Since orderBy needs to be called after selection, we apply it here.
      // Requested Ordering
      if (args.orderBy) {
        const direction = ob => (args.orderBy.direction === 'DESC' ? ob.desc().nullsLast() : ob.asc().nullsFirst());
        const fields = {
          TOTAL_CONTRIBUTED: 'totalContributed',
          TOTAL_EXPENDED: 'totalExpended',
          CREATED_AT: 'createdAt',
        };
        const field = fields[args.orderBy?.field] || args.orderBy?.field;
        assert(field, `Invalid orderBy field ${args.orderBy?.field} for vendors.`);
        nodeQuery = nodeQuery.orderBy(field, direction);
      }
      // Other additional ordering that were created throughout conditionals
      order.forEach(([field, direction]) => {
        nodeQuery = nodeQuery.orderBy(field, direction);
      });
      // Default ordering at last
      nodeQuery = nodeQuery.orderBy('Vendors.createdAt', 'desc');

      const countQuery = query.select(({ fn }) => fn.countAll<number>().as('count'));

      // Create thunks for resolving nodes and totalCount
      const nodes = () =>
        nodeQuery.limit(args.limit).offset(args.offset).execute().then(kyselyToSequelizeModels(Collective));
      const totalCount = () => countQuery.executeTakeFirst().then(result => result?.count || 0);

      return {
        nodes,
        totalCount,
        limit: args.limit,
        offset: args.offset,
      };
    },
  },
  potentialVendors: {
    type: new GraphQLNonNull(GraphQLAccountCollection),
    description:
      'Returns a list of organizations that only transacted with this host and all its admins are also admins of this host.',
    args: {
      ...getCollectionArgs({ limit: 100, offset: 0 }),
    },
    async resolve(host, args, req) {
      const isAdmin = req.remoteUser.isAdminOfCollective(host);
      if (!isAdmin) {
        throw new Unauthorized('You need to be logged in as an admin of the host to see its potential vendors');
      }

      const pageQuery = `
            WITH hostadmins AS (
              SELECT m."MemberCollectiveId", u."id" as "UserId"
              FROM "Members" m
              INNER JOIN "Users" u ON m."MemberCollectiveId" = u."CollectiveId"
              WHERE m."CollectiveId" = :hostid AND m."deletedAt" IS NULL AND m.role = 'ADMIN'
              ), orgs AS (
              SELECT c.id, c.slug,ARRAY_AGG(DISTINCT m."MemberCollectiveId") as "admins", ARRAY_AGG(DISTINCT t."HostCollectiveId") as hosts, c."CreatedByUserId"
              FROM "Collectives" c
              LEFT JOIN "Members" m ON c.id = m."CollectiveId" AND m."deletedAt" IS NULL AND m.role = 'ADMIN'
              LEFT JOIN "Transactions" t ON c.id = t."FromCollectiveId" AND t."deletedAt" IS NULL
              WHERE c."deletedAt" IS NULL
                AND c.type = 'ORGANIZATION'
                AND c."HostCollectiveId" IS NULL
              GROUP BY c.id
              )

            SELECT c.*
            FROM "orgs" o
            INNER JOIN "Collectives" c ON c.id = o.id
            WHERE
              (
                o."admins" <@ ARRAY(SELECT "MemberCollectiveId" FROM hostadmins)
                  OR (
                    o."CreatedByUserId" IN (
                    SELECT "UserId"
                    FROM hostadmins
                    )
                    AND o."admins" = ARRAY[null]::INTEGER[]
                  )
                )
              AND o."hosts" IN (ARRAY[:hostid], ARRAY[null]::INTEGER[])
            ORDER BY c."createdAt" DESC
            LIMIT :limit
            OFFSET :offset;
      `;

      const orgs = await sequelize.query(pageQuery, {
        replacements: {
          hostid: host.id,
          limit: args.limit,
          offset: args.offset,
        },
        type: QueryTypes.SELECT,
        model: models.Collective,
      });

      return {
        nodes: orgs,
        totalCount: orgs.length,
        limit: args.limit,
        offset: args.offset,
      };
    },
  },
  transactionsImports: {
    type: new GraphQLNonNull(GraphQLTransactionsImportsCollection),
    description: 'Returns a list of transactions imports for this host',
    args: {
      ...CollectionArgs,
      status: {
        type: GraphQLTransactionsImportStatus,
        description: 'Filter by status of transactions import',
      },
      orderBy: {
        type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
        description: 'The order of results',
        defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
      },
      type: {
        type: new GraphQLList(GraphQLTransactionsImportType),
        description: 'Filter by type of transactions import',
      },
    },
    async resolve(host, args, req) {
      checkRemoteUserCanUseTransactions(req);
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized('You need to be logged in as an admin of the host to see its transactions imports');
      }

      const where: Parameters<typeof models.TransactionsImport.findAll>[0]['where'] = { CollectiveId: host.id };

      if (args.status) {
        if (args.status === 'ACTIVE') {
          where['ConnectedAccountId'] = { [Op.not]: null };
        } else {
          where['ConnectedAccountId'] = null;
        }
      }

      if (args.type) {
        where['type'] = args.type;
      }

      return {
        limit: args.limit,
        offset: args.offset,
        totalCount: () => models.TransactionsImport.count({ where }),
        nodes: () =>
          models.TransactionsImport.findAll({
            where,
            limit: args.limit,
            offset: args.offset,
            order: [[args.orderBy.field, args.orderBy.direction]],
          }),
      };
    },
  },
  transactionsImportsSources: {
    type: new GraphQLNonNull(new GraphQLList(GraphQLNonEmptyString)),
    description: 'Returns a list of transactions imports sources for this host',
    args: {
      type: {
        type: new GraphQLList(GraphQLTransactionsImportType),
        description: 'Filter by type of transactions import',
      },
    },
    async resolve(host: Collective, args, req: express.Request) {
      checkRemoteUserCanUseHost(req);
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized(
          'You need to be logged in as an admin of the host to see its transactions imports sources',
        );
      }

      const where: Parameters<typeof models.TransactionsImport.findAll>[0]['where'] = {
        CollectiveId: host.id,
        ...(args.type && { type: args.type }),
      };

      return models.TransactionsImport.aggregate('source', 'DISTINCT', {
        plain: false,
        where,
      }).then((results: { DISTINCT: string }[]) => {
        return results.map(({ DISTINCT }) => DISTINCT);
      });
    },
  },
  offPlatformTransactions: {
    type: new GraphQLNonNull(GraphQLTransactionsImportRowCollection),
    args: {
      ...getCollectionArgs({ limit: 100 }),
      status: {
        type: GraphQLTransactionsImportRowStatus,
        description: 'Filter rows by status',
      },
      searchTerm: {
        type: GraphQLString,
        description: 'Search by text',
      },
      accountId: {
        type: new GraphQLList(GraphQLNonEmptyString),
        description: 'Filter rows by plaid account id',
      },
      importId: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLNonEmptyString)),
        description: 'The transactions import id(s)',
      },
      importType: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLTransactionsImportType)),
        description: 'Filter rows by import type',
      },
      orderBy: {
        type: new GraphQLNonNull(GraphQLTransactionsImportRowOrderInput),
        description: 'The order of results',
        defaultValue: { field: 'date', direction: 'DESC' },
      },
    },
    async resolve(
      host,
      args: {
        limit: number;
        offset: number;
        status: TransactionsImportRowStatus;
        searchTerm: string;
        accountId: string[];
        importId: string[];
        importType: string[];
        orderBy: { field: 'date'; direction: 'ASC' | 'DESC' };
      },
      req,
    ) {
      if (!req.remoteUser?.isAdminOfCollective(host)) {
        throw new Unauthorized('You need to be logged in as an admin of the host to see its off platform transactions');
      }

      checkRemoteUserCanUseTransactions(req);

      const importIds =
        args.importId &&
        (await Promise.all(
          args.importId?.map(async id =>
            isEntityPublicId(id, EntityShortIdPrefix.TransactionsImport)
              ? await req.loaders.TransactionsImport.idByPublicId.load(id)
              : idDecode(id, IDENTIFIER_TYPES.TRANSACTIONS_IMPORT),
          ),
        ));

      // This include is about:
      // 1. Security: making sure we only return transactions import rows for the host.
      // 2. Performance: the index on `TransactionsImports.CollectiveId` is used to filter the rows.
      const include: Parameters<typeof TransactionsImportRow.findAll>[0]['include'] = [
        {
          association: 'import',
          required: true,
          where: {
            ...((args.importType && { type: args.importType }) || {}),
            ...((args.importId && { id: uniq(importIds) }) || {}),
            CollectiveId: host.id,
          },
        },
      ];

      const where: Parameters<typeof TransactionsImportRow.findAll>[0]['where'] = [];

      // Filter by status
      if (args.status) {
        where.push({ status: args.status });
      }

      // Search term
      if (args.searchTerm) {
        where.push({
          [Op.or]: buildSearchConditions(args.searchTerm, {
            textFields: ['description', 'sourceId'],
            publicIdFields: [{ field: 'publicId', prefix: EntityShortIdPrefix.TransactionsImportRow }],
          }),
        });
      }

      // Filter by plaid account id
      if (args.accountId?.length) {
        // eslint-disable-next-line camelcase
        where.push({ rawValue: { account_id: { [Op.in]: args.accountId } } });
      }

      return {
        offset: args.offset,
        limit: args.limit,
        totalCount: () => TransactionsImportRow.count({ where, include }),
        nodes: () =>
          TransactionsImportRow.findAll({
            where,
            include,
            limit: args.limit,
            offset: args.offset,
            order: [
              [args.orderBy.field, args.orderBy.direction],
              ['id', args.orderBy.direction],
            ],
          }),
      };
    },
  },
  offPlatformTransactionsStats: {
    type: new GraphQLNonNull(GraphQLTransactionsImportStats),
    description: 'Returns stats for off platform transactions',
    async resolve(host, args, req) {
      if (!req.remoteUser?.isAdminOfCollective(host)) {
        throw new Unauthorized('You need to be logged in as an admin of the host to see its off platform transactions');
      }

      checkRemoteUserCanUseTransactions(req);
      return req.loaders.TransactionsImport.bankSynchronizationHostTransactionsStats.load(host.id);
    },
  },
  requiredLegalDocuments: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLLegalDocumentType))),
    description: 'Returns the legal documents required by this host',
    async resolve(host) {
      const documents = await models.RequiredLegalDocument.findAll({
        attributes: ['documentType'],
        where: { HostCollectiveId: host.id },
        raw: true,
      });

      return documents.map(({ documentType }) => documentType);
    },
  },
  hasDisputedOrders: {
    type: GraphQLBoolean,
    description: 'Returns whether the host has any Stripe disputed orders',
    async resolve(host, args, req) {
      if (!req.remoteUser?.isAdmin(host.id)) {
        return null;
      }

      return Boolean(
        await models.Order.count({
          where: { status: OrderStatuses.DISPUTED },
          include: [
            {
              model: models.Transaction,
              required: true,
              where: { HostCollectiveId: host.id, kind: TransactionKind.CONTRIBUTION },
            },
          ],
        }),
      );
    },
  },
  hasInReviewOrders: {
    type: GraphQLBoolean,
    description: 'Returns whether the host has any Stripe in review orders',
    async resolve(host, _, req) {
      if (!req.remoteUser?.isAdmin(host.id)) {
        return null;
      }

      return Boolean(
        await models.Order.count({
          where: { status: OrderStatuses.IN_REVIEW },
          include: [
            {
              model: models.Transaction,
              required: true,
              where: { HostCollectiveId: host.id, kind: TransactionKind.CONTRIBUTION },
            },
          ],
        }),
      );
    },
  },
  allowAddFundsFromAllAccounts: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Returns whether the host allows adding funds from all accounts',
    resolve: account =>
      Boolean(get(account, 'data.allowAddFundsFromAllAccounts') || get(account, 'data.isFirstPartyHost')),
  },
  contributionStats: {
    type: new GraphQLNonNull(GraphQLContributionStats),
    args: {
      account: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
        description: 'A collection of accounts for which the contribution stats should be returned.',
      },
      dateFrom: {
        type: GraphQLDateTime,
        description: 'Calculate contribution statistics beginning from this date.',
      },
      dateTo: {
        type: GraphQLDateTime,
        description: 'Calculate contribution statistics until this date.',
      },
      timeUnit: {
        type: GraphQLTimeUnit,
        description: 'The time unit of the time series',
      },
    },
    async resolve(host, args, req) {
      if (!req.remoteUser?.hasRole([roles.ADMIN, roles.ACCOUNTANT], host.id)) {
        throw new Unauthorized(
          'You need to be logged in as an admin or an accountant of the host to see the contribution stats.',
        );
      }
      const where: Parameters<typeof models.Transaction.findAll>[0]['where'] = {
        HostCollectiveId: host.id,
        kind: [TransactionKind.CONTRIBUTION, TransactionKind.ADDED_FUNDS],
        type: TransactionTypes.CREDIT,
        isRefund: false,
        RefundTransactionId: null,
      };
      const numberOfDays = getNumberOfDays(args.dateFrom, args.dateTo, host) || 1;
      const dateRange = getFilterDateRange(args.dateFrom, args.dateTo);
      if (dateRange) {
        where.createdAt = dateRange;
      }
      let collectiveIds;
      if (args.account) {
        const collectives = await fetchAccountsWithReferences(args.account, {
          throwIfMissing: true,
          attributes: ['id'],
        });
        collectiveIds = collectives.map(collective => collective.id);
        where.CollectiveId = { [Op.in]: collectiveIds };
      }

      const contributionsCountPromise = models.Transaction.findAll({
        attributes: [
          [sequelize.literal(`CASE WHEN "Order"."interval" IS NOT NULL THEN 'recurring' ELSE 'one-time' END`), 'label'],
          [sequelize.literal(`COUNT(*)`), 'count'],
          [sequelize.literal(`COUNT(DISTINCT "Order"."id")`), 'countDistinct'],
          [sequelize.literal(`SUM("Transaction"."amountInHostCurrency")`), 'sumAmount'],
        ],
        where,
        include: [{ model: models.Order, attributes: [] }],
        group: ['label'],
        raw: true,
      }) as unknown as Promise<
        Array<{
          label: 'one-time' | 'recurring';
          count: number;
          countDistinct: number;
          sumAmount: number;
        }>
      >;

      return {
        contributionsCount: contributionsCountPromise.then(results =>
          results.reduce((total, result) => total + result.count, 0),
        ),
        oneTimeContributionsCount: contributionsCountPromise.then(results =>
          results
            .filter(result => result.label === 'one-time')
            .reduce((total, result) => total + result.countDistinct, 0),
        ),
        recurringContributionsCount: contributionsCountPromise.then(results =>
          results
            .filter(result => result.label === 'recurring')
            .reduce((total, result) => total + result.countDistinct, 0),
        ),
        dailyAverageIncomeAmount: async () => {
          const contributionsAmountSum = await contributionsCountPromise.then(results =>
            results.reduce((total, result) => total + result.sumAmount, 0),
          );

          const dailyAverageIncomeAmount = contributionsAmountSum / numberOfDays;
          return {
            value: dailyAverageIncomeAmount || 0,
            currency: host.currency,
          };
        },
      };
    },
  },
  expenseStats: {
    type: new GraphQLNonNull(GraphQLExpenseStats),
    args: {
      account: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
        description: 'A collection of accounts for which the expense stats should be returned.',
      },
      dateFrom: {
        type: GraphQLDateTime,
        description: 'Calculate expense statistics beginning from this date.',
      },
      dateTo: {
        type: GraphQLDateTime,
        description: 'Calculate expense statistics until this date.',
      },
      timeUnit: {
        type: GraphQLTimeUnit,
        description:
          'The time unit of the time series (such as MONTH, YEAR, WEEK etc). If no value is provided this is calculated using the dateFrom and dateTo values.',
      },
    },
    async resolve(host, args, req) {
      if (!req.remoteUser?.hasRole([roles.ADMIN, roles.ACCOUNTANT], host.id)) {
        throw new Unauthorized(
          'You need to be logged in as an admin or an accountant of the host to see the expense stats.',
        );
      }
      const where: Parameters<typeof models.Transaction.findAll>[0]['where'] = {
        HostCollectiveId: host.id,
        kind: 'EXPENSE',
        type: TransactionTypes.DEBIT,
        isRefund: false,
        RefundTransactionId: null,
      };
      const numberOfDays = getNumberOfDays(args.dateFrom, args.dateTo, host) || 1;
      const dateRange = getFilterDateRange(args.dateFrom, args.dateTo);
      if (dateRange) {
        where.createdAt = dateRange;
      }
      let collectiveIds;
      if (args.account) {
        const collectives = await fetchAccountsWithReferences(args.account, { throwIfMissing: true });
        collectiveIds = collectives.map(collective => collective.id);
        where.CollectiveId = { [Op.in]: collectiveIds };
      }

      const expensesCountPromise = models.Transaction.findAll({
        attributes: [
          [sequelize.literal(`"Expense"."type"`), 'type'],
          [sequelize.literal(`COUNT(DISTINCT "Expense"."id")`), 'countDistinct'],
          [sequelize.literal(`COUNT(*)`), 'count'],
          [sequelize.literal(`SUM("Transaction"."amountInHostCurrency")`), 'sumAmount'],
        ],
        where,
        include: [{ model: models.Expense, attributes: [] }],
        group: ['Expense.type'],
        raw: true,
      }) as unknown as Promise<
        Array<{
          type: string;
          countDistinct: number;
          count: number;
          sumAmount: number;
        }>
      >;

      return {
        expensesCount: expensesCountPromise.then(results =>
          results.reduce((total, result) => total + result.countDistinct, 0),
        ),
        invoicesCount: expensesCountPromise.then(results =>
          results
            .filter(result => result.type === expenseType.INVOICE)
            .reduce((total, result) => total + result.countDistinct, 0),
        ),
        reimbursementsCount: expensesCountPromise.then(results =>
          results
            .filter(result => result.type === expenseType.RECEIPT)
            .reduce((total, result) => total + result.countDistinct, 0),
        ),
        grantsCount: expensesCountPromise.then(results =>
          results
            .filter(result => ([expenseType.FUNDING_REQUEST, expenseType.GRANT] as string[]).includes(result.type))
            .reduce((total, result) => total + result.countDistinct, 0),
        ),
        // NOTE: not supported here UNCLASSIFIED, SETTLEMENT, CHARGE
        dailyAverageAmount: async () => {
          const expensesAmountSum = await expensesCountPromise.then(results =>
            results.reduce((total, result) => total + result.sumAmount, 0),
          );

          const dailyAverageAmount = Math.abs(expensesAmountSum) / numberOfDays;
          return {
            value: dailyAverageAmount || 0,
            currency: host.currency,
          };
        },
      };
    },
  },
  supportedPaymentMethods: {
    type: new GraphQLList(GraphQLPaymentMethodLegacyType),
    description:
      'The list of payment methods (Stripe, Paypal, manual bank transfer, etc ...) the Host can accept for its Collectives',
    async resolve(collective, _, req) {
      const supportedPaymentMethods = [];

      // Paypal, Stripe = connected accounts
      const connectedAccounts = await req.loaders.Collective.connectedAccounts.load(collective.id);

      if (find(connectedAccounts, ['service', 'stripe'])) {
        supportedPaymentMethods.push('CREDIT_CARD');
        if (
          parseToBoolean(config.stripe.paymentIntentEnabled) ||
          (await hasFeature(collective, FEATURE.STRIPE_PAYMENT_INTENT, { loaders: req.loaders }))
        ) {
          supportedPaymentMethods.push(PaymentMethodLegacyTypeEnum.PAYMENT_INTENT);
        }
      }

      if (find(connectedAccounts, ['service', 'paypal']) && !collective.settings?.disablePaypalDonations) {
        supportedPaymentMethods.push('PAYPAL');
      }

      // Check for manual payment providers from the model
      const nbManualProviders = await models.ManualPaymentProvider.count({
        where: { CollectiveId: collective.id, archivedAt: null },
      });

      if (nbManualProviders > 0) {
        // The legacy "BANK_TRANSFER" type represents all types of manual payment providers
        supportedPaymentMethods.push('BANK_TRANSFER');
      }

      return supportedPaymentMethods;
    },
  },
  manualPaymentProviders: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLManualPaymentProvider))),
    description: 'Manual payment providers configured for this host',
    args: {
      type: {
        type: GraphQLManualPaymentProviderType,
        description: 'Filter by provider type',
      },
      includeArchived: {
        type: new GraphQLNonNull(GraphQLBoolean),
        defaultValue: false,
        description: 'Whether to include archived providers',
      },
    },
    async resolve(collective, args) {
      const where: Record<string, unknown> = { CollectiveId: collective.id };
      if (args.type) {
        where.type = args.type;
      }
      if (!args.includeArchived) {
        where.archivedAt = null;
      }
      return models.ManualPaymentProvider.findAll({
        where,
        order: [
          ['order', 'ASC'],
          ['createdAt', 'ASC'],
        ],
      });
    },
  },
  paypalClientId: {
    type: GraphQLString,
    description: 'If the host supports PayPal, this will contain the client ID to use in the frontend',
    resolve: async (host, _, req) => {
      const connectedAccounts = await req.loaders.Collective.connectedAccounts.load(host.id);
      const paypalAccount = connectedAccounts.find(c => c.service === 'paypal');
      return paypalAccount?.clientId || null;
    },
  },
  supportedPayoutMethods: {
    type: new GraphQLList(GraphQLPayoutMethodType),
    description: 'The list of payout methods this Host accepts for its expenses',
    async resolve(host, _, req) {
      const connectedAccounts: ConnectedAccount[] = await req.loaders.Collective.connectedAccounts.load(host.id);
      const supportedPayoutMethods = [
        PayoutMethodTypes.ACCOUNT_BALANCE,
        PayoutMethodTypes.BANK_ACCOUNT,
        PayoutMethodTypes.STRIPE,
      ];

      // Check for PayPal (Payouts via ConnectedAccount)
      if (
        (connectedAccounts?.find?.(c => c.service === 'paypal') && !host.settings?.disablePaypalPayouts) ||
        host.settings?.payouts?.enableManualPayPalPayments
      ) {
        supportedPayoutMethods.push(PayoutMethodTypes.PAYPAL);
      }

      if (!host.settings?.disableCustomPayoutMethod) {
        supportedPayoutMethods.push(PayoutMethodTypes.OTHER);
      }

      return supportedPayoutMethods;
    },
  },
  stripe: {
    type: GraphQLStripeConnectedAccount,
    description: 'Stripe connected account',
    async resolve(host, _, req) {
      if (!req.remoteUser?.isAdmin(host.id)) {
        return null;
      }

      try {
        return await host.getAccountForPaymentProvider('stripe');
      } catch {
        return null;
      }
    },
  },
  accountingCategories: {
    type: new GraphQLNonNull(GraphQLAccountingCategoryCollection),
    description: 'List of accounting categories for this host',
    args: {
      kind: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLAccountingCategoryKind)),
        description: 'Filter accounting categories by kind',
      },
      account: {
        type: GraphQLAccountReferenceInput,
        description: 'Filter by accounting category applicable to this account',
      },
    },
    // Not paginated yet as we don't expect to have too many categories for now
    async resolve(host, args, req) {
      const where: Parameters<typeof models.AccountingCategory.findAll>[0]['where'] = { CollectiveId: host.id };
      const order: Parameters<typeof models.AccountingCategory.findAll>[0]['order'] = [['code', 'ASC']]; // Code is unique per host, so sorting on it here should be consistent
      if (args.kind) {
        where.kind = uniq(args.kind);
      }

      if (!req.remoteUser?.isAdmin(host.id)) {
        where.hostOnly = false;
      }

      const account = args.account
        ? await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true })
        : null;

      if (account) {
        where.appliesTo = [account.id, account.ParentCollectiveId].includes(host.id)
          ? AccountingCategoryAppliesTo.HOST
          : AccountingCategoryAppliesTo.HOSTED_COLLECTIVES;
      }

      const categories = await models.AccountingCategory.findAll({ where, order });
      return {
        nodes: categories,
        totalCount: categories.length,
        limit: categories.length,
        offset: 0,
      };
    },
  },
  contributionAccountingCategoryRules: {
    type: new GraphQLList(new GraphQLNonNull(GraphQLContributionAccountingCategoryRule)),
    resolve(host, _, req) {
      if (!req?.remoteUser?.isAdmin(host.id)) {
        return [];
      }
      return AccountingCategoryRule.findAll({
        where: { CollectiveId: host.id, type: 'CONTRIBUTION' },
        order: [['order', 'ASC']],
      });
    },
  },
});

export const GraphQLOrganization = new GraphQLObjectType({
  name: 'Organization',
  description: 'This represents an Organization account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithContributions, GraphQLAccountWithPlatformSubscription],
  isTypeOf: collective => collective.type === 'ORGANIZATION',
  fields: getOrganizationFields,
});
