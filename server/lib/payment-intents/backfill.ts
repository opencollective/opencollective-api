import { Transaction as SequelizeTransaction } from 'sequelize';

import ExpenseStatus from '../../constants/expense-status';
import OrderStatus from '../../constants/order-status';
import { TransactionKind } from '../../constants/transaction-kind';
import { Collective, Expense, Op, Order, sequelize, Transaction } from '../../models';
import PaymentIntent from '../../models/PaymentIntent';
import logger from '../logger';
import { isPrimaryTransactionKind } from '../transactions/kind-priority';

import { backfillPaymentIntentFromSource } from './sync';

const PRIMARY_TRANSACTION_KINDS = [
  TransactionKind.CONTRIBUTION,
  TransactionKind.EXPENSE,
  TransactionKind.ADDED_FUNDS,
  TransactionKind.BALANCE_TRANSFER,
  TransactionKind.PREPAID_PAYMENT_METHOD,
] as const;

const ORDER_LEDGER_EXCLUDED_STATUSES = [
  OrderStatus.PAID,
  OrderStatus.ACTIVE,
  OrderStatus.REFUNDED,
  OrderStatus.ERROR,
  OrderStatus.REJECTED,
  OrderStatus.DISPUTED,
] as const;

const EXPENSE_LEDGER_EXCLUDED_STATUSES = [ExpenseStatus.PAID, ExpenseStatus.ERROR, ExpenseStatus.REJECTED] as const;

export type BackfillPhase = 'ledger' | 'pending-orders' | 'pending-expenses' | 'all';

type BackfillOptions = {
  dryRun?: boolean;
  limit?: number;
  afterId?: number;
  orderIds?: number[];
  expenseIds?: number[];
  hostIds?: number[];
  batchSize?: number;
};

type BackfillPhaseStats = {
  processed: number;
  skipped: number;
  errors: number;
  warnings: number;
  errorIds: number[];
  lastId: number;
};

const emptyStats = (): BackfillPhaseStats => ({
  processed: 0,
  skipped: 0,
  errors: 0,
  warnings: 0,
  errorIds: [],
  lastId: 0,
});

const primaryKindSqlList = PRIMARY_TRANSACTION_KINDS.map(kind => `'${kind}'`).join(',');

const noPaymentIntentForOrderSql = `NOT EXISTS (
  SELECT 1 FROM "PaymentIntents" pi
  WHERE pi."OrderId" = "Order"."id" AND pi."deletedAt" IS NULL
)`;

const noPaymentIntentForExpenseSql = `NOT EXISTS (
  SELECT 1 FROM "PaymentIntents" pi
  WHERE pi."ExpenseId" = "Expense"."id" AND pi."deletedAt" IS NULL
)`;

const hasPrimaryLedgerForOrderSql = `EXISTS (
  SELECT 1 FROM "Transactions" t
  WHERE t."OrderId" = "Order"."id"
    AND t."kind" IN (${primaryKindSqlList})
    AND t."isRefund" = false
    AND t."deletedAt" IS NULL
)`;

const hasPrimaryLedgerForExpenseSql = `EXISTS (
  SELECT 1 FROM "Transactions" t
  WHERE t."ExpenseId" = "Expense"."id"
    AND t."kind" IN (${primaryKindSqlList})
    AND t."isRefund" = false
    AND t."deletedAt" IS NULL
)`;

const noPrimaryLedgerForOrderSql = `NOT EXISTS (
  SELECT 1 FROM "Transactions" t
  WHERE t."OrderId" = "Order"."id"
    AND t."kind" IN (${primaryKindSqlList})
    AND t."isRefund" = false
    AND t."deletedAt" IS NULL
)`;

const noPrimaryLedgerForExpenseSql = `NOT EXISTS (
  SELECT 1 FROM "Transactions" t
  WHERE t."ExpenseId" = "Expense"."id"
    AND t."kind" IN (${primaryKindSqlList})
    AND t."isRefund" = false
    AND t."deletedAt" IS NULL
)`;

const pickPrimaryFromGroup = (transactions: Transaction[]): Transaction | null =>
  transactions.find(t => isPrimaryTransactionKind(t.kind)) ??
  transactions.find(t => t.type === 'CREDIT') ??
  transactions[0] ??
  null;

const findPrimaryChargeTransactionForOrder = async (orderId: number): Promise<Transaction | null> => {
  const transactions = await Transaction.findAll({
    where: {
      OrderId: orderId,
      isRefund: false,
      kind: { [Op.in]: [...PRIMARY_TRANSACTION_KINDS] },
    },
    order: [['id', 'ASC']],
  });

  return findPrimaryChargeTransaction(transactions);
};

const findPrimaryChargeTransactionForExpense = async (expenseId: number): Promise<Transaction | null> => {
  const transactions = await Transaction.findAll({
    where: {
      ExpenseId: expenseId,
      isRefund: false,
      kind: { [Op.in]: [...PRIMARY_TRANSACTION_KINDS] },
    },
    order: [['id', 'ASC']],
  });

  return findPrimaryChargeTransaction(transactions);
};

const findPrimaryChargeTransaction = (transactions: Transaction[]): Transaction | null => {
  const groups = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    const group = groups.get(transaction.TransactionGroup) ?? [];
    group.push(transaction);
    groups.set(transaction.TransactionGroup, group);
  }

  let bestPrimary: Transaction | null = null;
  for (const groupTransactions of groups.values()) {
    const primary = pickPrimaryFromGroup(groupTransactions);
    if (!primary || !isPrimaryTransactionKind(primary.kind)) {
      continue;
    }

    if (
      !bestPrimary ||
      primary.createdAt < bestPrimary.createdAt ||
      (primary.createdAt.getTime() === bestPrimary.createdAt.getTime() && primary.id < bestPrimary.id)
    ) {
      bestPrimary = primary;
    }
  }

  return bestPrimary;
};

const findRefundTransactionForOrder = async (orderId: number): Promise<Transaction | null> =>
  Transaction.findOne({
    where: {
      OrderId: orderId,
      isRefund: true,
      kind: { [Op.in]: [...PRIMARY_TRANSACTION_KINDS] },
      type: 'CREDIT',
    },
    order: [['id', 'ASC']],
  });

const findRefundTransactionForExpense = async (expenseId: number): Promise<Transaction | null> =>
  Transaction.findOne({
    where: {
      ExpenseId: expenseId,
      isRefund: true,
      kind: { [Op.in]: [...PRIMARY_TRANSACTION_KINDS] },
      type: 'CREDIT',
    },
    order: [['id', 'ASC']],
  });

const buildHostCollectiveFilter = (hostIds?: number[]) => {
  if (!hostIds?.length) {
    return null;
  }

  return sequelize.literal(`"Order"."CollectiveId" IN (
    SELECT id FROM "Collectives" WHERE "HostCollectiveId" IN (${hostIds.join(',')})
  )`);
};

const buildHostCollectiveFilterForExpense = (hostIds?: number[]) => {
  if (!hostIds?.length) {
    return null;
  }

  return sequelize.literal(`"Expense"."CollectiveId" IN (
    SELECT id FROM "Collectives" WHERE "HostCollectiveId" IN (${hostIds.join(',')})
  )`);
};

export const backfillPaymentIntentForOrderLedger = async (
  orderId: number,
  { dryRun = false }: Pick<BackfillOptions, 'dryRun'> = {},
): Promise<'processed' | 'skipped' | 'dry_run'> => {
  const existing = await PaymentIntent.findOne({ where: { OrderId: orderId } });
  if (existing) {
    return 'skipped';
  }

  const order = await Order.findByPk(orderId);
  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }

  const primaryTransaction = await findPrimaryChargeTransactionForOrder(orderId);
  if (!primaryTransaction) {
    return 'skipped';
  }

  const refundTransaction = await findRefundTransactionForOrder(orderId);
  const isReversed = order.status === OrderStatus.REFUNDED || Boolean(refundTransaction);

  if (dryRun) {
    logger.info(
      `[dry-run] ledger order ${orderId}: primaryGroup=${primaryTransaction.TransactionGroup}, reversed=${isReversed}`,
    );
    return 'dry_run';
  }

  await sequelize.transaction(async (sqlTransaction: SequelizeTransaction) => {
    await backfillPaymentIntentFromSource(
      { transaction: primaryTransaction },
      { trigger: 'ledger', sequelizeTransaction: sqlTransaction },
    );

    if (isReversed && refundTransaction) {
      await backfillPaymentIntentFromSource(
        { transaction: refundTransaction },
        { trigger: 'refund', sequelizeTransaction: sqlTransaction },
      );
    }
  });

  return 'processed';
};

const backfillPaymentIntentForExpenseLedger = async (
  expenseId: number,
  { dryRun = false }: Pick<BackfillOptions, 'dryRun'> = {},
): Promise<'processed' | 'skipped' | 'dry_run'> => {
  const existing = await PaymentIntent.findOne({ where: { ExpenseId: expenseId } });
  if (existing) {
    return 'skipped';
  }

  const expense = await Expense.findByPk(expenseId);
  if (!expense) {
    throw new Error(`Expense ${expenseId} not found`);
  }

  const primaryTransaction = await findPrimaryChargeTransactionForExpense(expenseId);
  if (!primaryTransaction) {
    return 'skipped';
  }

  const refundTransaction = await findRefundTransactionForExpense(expenseId);
  const isReversed = Boolean(refundTransaction);

  if (dryRun) {
    logger.info(
      `[dry-run] ledger expense ${expenseId}: primaryGroup=${primaryTransaction.TransactionGroup}, reversed=${isReversed}`,
    );
    return 'dry_run';
  }

  await sequelize.transaction(async (sqlTransaction: SequelizeTransaction) => {
    await backfillPaymentIntentFromSource(
      { transaction: primaryTransaction },
      { trigger: 'ledger', sequelizeTransaction: sqlTransaction },
    );

    if (isReversed && refundTransaction) {
      await backfillPaymentIntentFromSource(
        { transaction: refundTransaction },
        { trigger: 'refund', sequelizeTransaction: sqlTransaction },
      );
    }
  });

  return 'processed';
};

export const backfillPaymentIntentForPendingOrder = async (
  orderId: number,
  { dryRun = false }: Pick<BackfillOptions, 'dryRun'> = {},
): Promise<'processed' | 'skipped' | 'dry_run'> => {
  const existing = await PaymentIntent.findOne({ where: { OrderId: orderId } });
  if (existing) {
    return 'skipped';
  }

  const order = await Order.findByPk(orderId);
  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }

  if (dryRun) {
    logger.info(`[dry-run] pending order ${orderId}: status=${order.status}`);
    return 'dry_run';
  }

  await sequelize.transaction(async (sqlTransaction: SequelizeTransaction) => {
    await backfillPaymentIntentFromSource({ order }, { trigger: 'lifecycle', sequelizeTransaction: sqlTransaction });
  });

  return 'processed';
};

export const backfillPaymentIntentForPendingExpense = async (
  expenseId: number,
  { dryRun = false }: Pick<BackfillOptions, 'dryRun'> = {},
): Promise<'processed' | 'skipped' | 'dry_run'> => {
  const existing = await PaymentIntent.findOne({ where: { ExpenseId: expenseId } });
  if (existing) {
    return 'skipped';
  }

  const expense = await Expense.findByPk(expenseId);
  if (!expense) {
    throw new Error(`Expense ${expenseId} not found`);
  }

  if (dryRun) {
    logger.info(`[dry-run] pending expense ${expenseId}: status=${expense.status}`);
    return 'dry_run';
  }

  await sequelize.transaction(async (sqlTransaction: SequelizeTransaction) => {
    await backfillPaymentIntentFromSource({ expense }, { trigger: 'lifecycle', sequelizeTransaction: sqlTransaction });
  });

  return 'processed';
};

const processBatch = async <T extends { id: number }>(
  records: T[],
  stats: BackfillPhaseStats,
  handler: (id: number) => Promise<'processed' | 'skipped' | 'dry_run'>,
): Promise<void> => {
  for (const record of records) {
    stats.lastId = record.id;
    try {
      const result = await handler(record.id);
      if (result === 'processed' || result === 'dry_run') {
        stats.processed++;
      } else {
        stats.skipped++;
      }
    } catch (error) {
      stats.errors++;
      stats.errorIds.push(record.id);
      logger.error(`Backfill error for id ${record.id}:`, error);
    }
  }
};

export const backfillLedgerPhase = async (options: BackfillOptions = {}): Promise<BackfillPhaseStats> => {
  const stats = emptyStats();
  const batchSize = options.batchSize ?? 100;
  const limit = options.limit ?? Infinity;
  const processOrders = !options.expenseIds?.length || Boolean(options.orderIds?.length);
  const processExpenses = !options.orderIds?.length || Boolean(options.expenseIds?.length);

  if (processOrders) {
    let afterId = options.afterId ?? 0;
    let remaining = limit;

    while (remaining > 0) {
      const pageSize = Math.min(batchSize, remaining);
      const orderWhere = {
        id: { [Op.gt]: afterId, ...(options.orderIds?.length ? { [Op.in]: options.orderIds } : {}) },
        [Op.and]: [
          sequelize.literal(noPaymentIntentForOrderSql),
          sequelize.literal(hasPrimaryLedgerForOrderSql),
          ...(buildHostCollectiveFilter(options.hostIds) ? [buildHostCollectiveFilter(options.hostIds)] : []),
        ],
      };

      const orders = await Order.findAll({
        where: orderWhere,
        attributes: ['id'],
        order: [['id', 'ASC']],
        limit: pageSize,
      });

      if (!orders.length) {
        break;
      }

      await processBatch(orders, stats, orderId => backfillPaymentIntentForOrderLedger(orderId, options));
      afterId = orders[orders.length - 1].id;
      remaining -= orders.length;

      if (stats.processed % 100 === 0 && stats.processed > 0) {
        logger.info(`Ledger orders: processed ${stats.processed}, lastId=${stats.lastId}`);
      }

      if (orders.length < pageSize) {
        break;
      }
    }
  }

  if (processExpenses) {
    let expenseAfterId = options.afterId ?? 0;
    let expenseRemaining = options.orderIds?.length ? limit : limit - stats.processed;

    while (expenseRemaining > 0) {
      const pageSize = Math.min(batchSize, expenseRemaining);
      const expenseWhere = {
        id: { [Op.gt]: expenseAfterId, ...(options.expenseIds?.length ? { [Op.in]: options.expenseIds } : {}) },
        [Op.and]: [
          sequelize.literal(noPaymentIntentForExpenseSql),
          sequelize.literal(hasPrimaryLedgerForExpenseSql),
          ...(buildHostCollectiveFilterForExpense(options.hostIds)
            ? [buildHostCollectiveFilterForExpense(options.hostIds)]
            : []),
        ],
      };

      const expenses = await Expense.findAll({
        where: expenseWhere,
        attributes: ['id'],
        order: [['id', 'ASC']],
        limit: pageSize,
      });

      if (!expenses.length) {
        break;
      }

      await processBatch(expenses, stats, expenseId => backfillPaymentIntentForExpenseLedger(expenseId, options));
      expenseAfterId = expenses[expenses.length - 1].id;
      expenseRemaining -= expenses.length;

      if (stats.processed % 100 === 0 && stats.processed > 0) {
        logger.info(`Ledger expenses: processed ${stats.processed}, lastId=${stats.lastId}`);
      }

      if (expenses.length < pageSize) {
        break;
      }
    }
  }

  return stats;
};

const backfillPendingOrdersPhase = async (options: BackfillOptions = {}): Promise<BackfillPhaseStats> => {
  const stats = emptyStats();
  const batchSize = options.batchSize ?? 100;
  const limit = options.limit ?? Infinity;
  let afterId = options.afterId ?? 0;
  let remaining = limit;

  while (remaining > 0) {
    const pageSize = Math.min(batchSize, remaining);
    const orders = await Order.findAll({
      where: {
        id: { [Op.gt]: afterId, ...(options.orderIds?.length ? { [Op.in]: options.orderIds } : {}) },
        status: { [Op.notIn]: ORDER_LEDGER_EXCLUDED_STATUSES },
        [Op.and]: [
          sequelize.literal(noPaymentIntentForOrderSql),
          sequelize.literal(noPrimaryLedgerForOrderSql),
          ...(buildHostCollectiveFilter(options.hostIds) ? [buildHostCollectiveFilter(options.hostIds)] : []),
        ],
      },
      attributes: ['id'],
      order: [['id', 'ASC']],
      limit: pageSize,
    });

    if (!orders.length) {
      break;
    }

    await processBatch(orders, stats, orderId => backfillPaymentIntentForPendingOrder(orderId, options));
    afterId = orders[orders.length - 1].id;
    remaining -= orders.length;

    if (stats.processed % 100 === 0 && stats.processed > 0) {
      logger.info(`Pending orders: processed ${stats.processed}, lastId=${stats.lastId}`);
    }

    if (orders.length < pageSize) {
      break;
    }
  }

  return stats;
};

const backfillPendingExpensesPhase = async (options: BackfillOptions = {}): Promise<BackfillPhaseStats> => {
  const stats = emptyStats();
  const batchSize = options.batchSize ?? 100;
  const limit = options.limit ?? Infinity;
  let afterId = options.afterId ?? 0;
  let remaining = limit;

  while (remaining > 0) {
    const pageSize = Math.min(batchSize, remaining);
    const expenses = await Expense.findAll({
      where: {
        id: { [Op.gt]: afterId, ...(options.expenseIds?.length ? { [Op.in]: options.expenseIds } : {}) },
        status: { [Op.notIn]: EXPENSE_LEDGER_EXCLUDED_STATUSES },
        [Op.and]: [
          sequelize.literal(noPaymentIntentForExpenseSql),
          sequelize.literal(noPrimaryLedgerForExpenseSql),
          ...(buildHostCollectiveFilterForExpense(options.hostIds)
            ? [buildHostCollectiveFilterForExpense(options.hostIds)]
            : []),
        ],
      },
      attributes: ['id'],
      order: [['id', 'ASC']],
      limit: pageSize,
    });

    if (!expenses.length) {
      break;
    }

    await processBatch(expenses, stats, expenseId => backfillPaymentIntentForPendingExpense(expenseId, options));
    afterId = expenses[expenses.length - 1].id;
    remaining -= expenses.length;

    if (stats.processed % 100 === 0 && stats.processed > 0) {
      logger.info(`Pending expenses: processed ${stats.processed}, lastId=${stats.lastId}`);
    }

    if (expenses.length < pageSize) {
      break;
    }
  }

  return stats;
};

export const resolveHostIdsFromSlugs = async (hostSlugs: string[]): Promise<number[]> => {
  const hosts = await Collective.findAll({
    where: { slug: { [Op.in]: hostSlugs } },
    attributes: ['id'],
  });
  return hosts.map(host => host.id);
};

export const runBackfill = async (
  phase: BackfillPhase,
  options: BackfillOptions = {},
): Promise<Record<string, BackfillPhaseStats>> => {
  const results: Record<string, BackfillPhaseStats> = {};

  if (phase === 'ledger' || phase === 'all') {
    logger.info('Starting ledger backfill phase...');
    results.ledger = await backfillLedgerPhase(options);
    logPhaseSummary('ledger', results.ledger);
  }

  if (phase === 'pending-orders' || phase === 'all') {
    logger.info('Starting pending-orders backfill phase...');
    results['pending-orders'] = await backfillPendingOrdersPhase(options);
    logPhaseSummary('pending-orders', results['pending-orders']);
  }

  if (phase === 'pending-expenses' || phase === 'all') {
    logger.info('Starting pending-expenses backfill phase...');
    results['pending-expenses'] = await backfillPendingExpensesPhase(options);
    logPhaseSummary('pending-expenses', results['pending-expenses']);
  }

  return results;
};

const logPhaseSummary = (phaseName: string, stats: BackfillPhaseStats): void => {
  logger.info(
    `Phase ${phaseName} complete: processed=${stats.processed}, skipped=${stats.skipped}, errors=${stats.errors}, warnings=${stats.warnings}, lastId=${stats.lastId}`,
  );
  if (stats.errorIds.length) {
    logger.error(`Phase ${phaseName} error ids: ${stats.errorIds.join(', ')}`);
  }
};
