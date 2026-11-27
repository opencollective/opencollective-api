/**
 * Feature probes: the data an account must have for one of its features to be `ACTIVE` rather than `AVAILABLE`
 * ("has a published update", "has received an invoice", ...). A probe depends on the account only, never on the viewer.
 *
 * All the probes of a request are answered together: one row per account, one `EXISTS (...)` column per probe.
 */
import DataLoader from 'dataloader';
import { type Expression, expressionBuilder, sql, type SqlBool } from 'kysely';
import { chunk, groupBy } from 'lodash';

import { CollectiveType } from '../../constants/collectives';
import { Service } from '../../constants/connected-account';
import ExpenseTypes from '../../constants/expense-type';
import OrderStatuses from '../../constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import MemberRoles from '../../constants/roles';
import { type DatabaseWithViews, getKysely } from '../../lib/kysely';

type AccountId = Expression<number>;

const db = expressionBuilder<DatabaseWithViews, never>();

/** The body of each `EXISTS (...)`, for the account whose id is given */
export const FEATURE_PROBES = {
  HAS_CONNECTED_COLLECTIVES: (id: AccountId) =>
    db
      .selectFrom('Members')
      .select(sql.lit(1).as('one'))
      .where('CollectiveId', '=', id)
      .where('deletedAt', 'is', null)
      .where('role', '=', MemberRoles.CONNECTED_COLLECTIVE),
  HAS_CONVERSATIONS: (id: AccountId) =>
    db
      .selectFrom('Conversations')
      .select(sql.lit(1).as('one'))
      .where('CollectiveId', '=', id)
      .where('deletedAt', 'is', null),
  HAS_EVENTS: (id: AccountId) =>
    db
      .selectFrom('Collectives')
      .select(sql.lit(1).as('one'))
      .where('ParentCollectiveId', '=', id)
      .where('deletedAt', 'is', null)
      .where('type', '=', CollectiveType.EVENT),
  HAS_PROJECTS: (id: AccountId) =>
    db
      .selectFrom('Collectives')
      .select(sql.lit(1).as('one'))
      .where('ParentCollectiveId', '=', id)
      .where('deletedAt', 'is', null)
      .where('type', '=', CollectiveType.PROJECT),
  HAS_PUBLISHED_UPDATES: (id: AccountId) =>
    db
      .selectFrom('Updates')
      .select(sql.lit(1).as('one'))
      .where('CollectiveId', '=', id)
      .where('deletedAt', 'is', null)
      .where('publishedAt', 'is not', null),
  /** Contributions made by the account */
  HAS_ACTIVE_RECURRING_CONTRIBUTIONS: (id: AccountId) =>
    db
      .selectFrom('Orders')
      .select(sql.lit(1).as('one'))
      .where('FromCollectiveId', '=', id)
      .where('deletedAt', 'is', null)
      .where('SubscriptionId', 'is not', null)
      .where('status', '=', OrderStatuses.ACTIVE),
  /** Contributions made to the account */
  HAS_RECEIVED_CONTRIBUTIONS: (id: AccountId) =>
    db
      .selectFrom('Orders')
      .select(sql.lit(1).as('one'))
      .where('CollectiveId', '=', id)
      .where('deletedAt', 'is', null)
      .where('status', 'in', [OrderStatuses.ACTIVE, OrderStatuses.PAID]),
  HAS_TIERS: (id: AccountId) =>
    db.selectFrom('Tiers').select(sql.lit(1).as('one')).where('CollectiveId', '=', id).where('deletedAt', 'is', null),
  HAS_RECEIVED_EXPENSES: (id: AccountId) =>
    db
      .selectFrom('Expenses')
      .select(sql.lit(1).as('one'))
      .where('CollectiveId', '=', id)
      .where('deletedAt', 'is', null)
      .where('type', 'in', [ExpenseTypes.INVOICE, ExpenseTypes.RECEIPT]),
  HAS_RECEIVED_GRANTS: (id: AccountId) =>
    db
      .selectFrom('Expenses')
      .select(sql.lit(1).as('one'))
      .where('CollectiveId', '=', id)
      .where('deletedAt', 'is', null)
      .where('type', '=', ExpenseTypes.GRANT),
  /** Only the transactions on the account itself (`CollectiveId`), not the ones it is the counterparty of */
  HAS_TRANSACTIONS: (id: AccountId) =>
    db
      .selectFrom('Transactions')
      .select(sql.lit(1).as('one'))
      .where('CollectiveId', '=', id)
      .where('deletedAt', 'is', null),
  HAS_PAYPAL_ACCOUNT: (id: AccountId) =>
    db
      .selectFrom('ConnectedAccounts')
      .select(sql.lit(1).as('one'))
      .where('CollectiveId', '=', id)
      .where('deletedAt', 'is', null)
      .where('service', '=', Service.PAYPAL),
  HAS_WISE_ACCOUNT: (id: AccountId) =>
    db
      .selectFrom('ConnectedAccounts')
      .select(sql.lit(1).as('one'))
      .where('CollectiveId', '=', id)
      .where('deletedAt', 'is', null)
      .where('service', '=', Service.TRANSFERWISE),
  /** Payment methods that let an account contribute whatever its type: prepaid budgets, gift cards and credit cards */
  HAS_USABLE_PAYMENT_METHODS: (id: AccountId) =>
    db
      .selectFrom('PaymentMethods')
      .select(sql.lit(1).as('one'))
      .where('CollectiveId', '=', id)
      .where('deletedAt', 'is', null)
      .where(eb =>
        eb.or([
          eb.and([
            eb('service', '=', PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE),
            eb('type', 'in', [PAYMENT_METHOD_TYPE.PREPAID, PAYMENT_METHOD_TYPE.GIFTCARD]),
          ]),
          eb.and([eb('service', '=', PAYMENT_METHOD_SERVICE.STRIPE), eb('type', '=', PAYMENT_METHOD_TYPE.CREDITCARD)]),
        ]),
      ),
  /** Virtual cards assigned to the account */
  HAS_VIRTUAL_CARDS: (id: AccountId) =>
    db
      .selectFrom('VirtualCards')
      .select(sql.lit(1).as('one'))
      .where('CollectiveId', '=', id)
      .where('deletedAt', 'is', null),
  /** Virtual cards issued by the account as a host */
  HAS_HOSTED_VIRTUAL_CARDS: (id: AccountId) =>
    db
      .selectFrom('VirtualCards')
      .select(sql.lit(1).as('one'))
      .where('HostCollectiveId', '=', id)
      .where('deletedAt', 'is', null),
} as const;

export type FeatureProbe = keyof typeof FEATURE_PROBES;
export type FeatureProbeKey = { accountId: number; probe: FeatureProbe };

/**
 * Above this number of accounts, Postgres starts answering some probes by hashing every matching row of the table
 * (all events, all projects) instead of one index lookup per account.
 */
const MAX_ACCOUNTS_PER_STATEMENT = 200;

/** Integer ids as one array literal, like `server/lib/sql-search.ts` */
const intArray = (ids: number[]) => sql<number[]>`${sql.lit(`{${ids.map(Number).join(',')}}`)}::int[]`;

/**
 * One statement for all keys:
 *
 *   SELECT a.id, EXISTS (...) AS "HAS_TRANSACTIONS", EXISTS (...) AS "HAS_EVENTS", ... FROM unnest('{1,2}'::int[]) AS a(id)
 *
 * When only some accounts ask for a probe, its column is `NULL` for the others, which skips their lookup.
 */
const buildFeatureProbesQuery = (keys: readonly FeatureProbeKey[]) => {
  const accountIds = Array.from(new Set(keys.map(key => key.accountId)));
  const keysByProbe = groupBy(keys, key => key.probe) as Partial<Record<FeatureProbe, FeatureProbeKey[]>>;
  return getKysely()
    .selectFrom(sql<{ id: number }>`unnest(${intArray(accountIds)})`.as<'a'>(sql`a(id)`))
    .select('a.id')
    .select(eb =>
      Object.entries(keysByProbe).map(([probe, probeKeys]) => {
        const hasData = eb.exists(FEATURE_PROBES[probe as FeatureProbe](eb.ref('a.id')));
        const probedIds = Array.from(new Set(probeKeys.map(key => key.accountId)));
        return probedIds.length === accountIds.length
          ? hasData.as(probe)
          : eb
              .case()
              .when(sql<SqlBool>`${eb.ref('a.id')} = ANY(${intArray(probedIds)})`)
              .then(hasData)
              .end()
              .as(probe);
      }),
    );
};

/** Answers the probes in the order of `keys`, with as few statements as possible. No caching. */
export const queryFeatureProbes = async (keys: readonly FeatureProbeKey[]): Promise<boolean[]> => {
  const keysByAccount = Object.values(groupBy(keys, key => key.accountId));
  const rows = await Promise.all(
    chunk(keysByAccount, MAX_ACCOUNTS_PER_STATEMENT).map(accountsKeys =>
      buildFeatureProbesQuery(accountsKeys.flat()).execute(),
    ),
  );

  const rowsByAccountId = new Map(rows.flat().map(row => [row.id, row as Record<string, unknown>]));
  return keys.map(({ accountId, probe }) => rowsByAccountId.get(accountId)?.[probe] === true);
};

export const generateFeatureProbesLoader = () =>
  new DataLoader<FeatureProbeKey, boolean, string>(queryFeatureProbes, {
    cacheKeyFn: ({ accountId, probe }) => `${accountId}:${probe}`,
  });
