import { Transaction as SequelizeTransaction } from 'sequelize';

import PaymentIntentStatus from '../../constants/payment-intent-status';
import models from '../../models';
import Collective from '../../models/Collective';
import Expense from '../../models/Expense';
import Order from '../../models/Order';
import PaymentIntent from '../../models/PaymentIntent';
import Transaction from '../../models/Transaction';
import { reportErrorToSentry } from '../sentry';
import { isPrimaryTransactionKind } from '../transactions/kind-priority';

import {
  mapPaymentIntentDescription,
  mapPaymentIntentPaidAt,
  mapPaymentIntentParties,
  mapPaymentIntentStatus,
  mapPaymentIntentType,
  PaymentIntentMappingInput,
} from './mappers';

type PaymentIntentSyncTrigger = 'lifecycle' | 'ledger' | 'refund' | 'soft-delete';

type BackfillPaymentIntentTrigger = Exclude<PaymentIntentSyncTrigger, 'soft-delete'>;

type UpsertPaymentIntentSource = {
  order?: Order;
  expense?: Expense;
  transaction?: Transaction;
};

type UpsertPaymentIntentOptions = {
  sequelizeTransaction?: SequelizeTransaction;
  trigger: PaymentIntentSyncTrigger;
};

const loadOrderForTransaction = async (
  transaction: Transaction,
  sequelizeTransaction?: SequelizeTransaction,
): Promise<Order | null> => {
  if (!transaction.OrderId) {
    return null;
  }
  return models.Order.findByPk(transaction.OrderId, { transaction: sequelizeTransaction });
};

const loadExpenseForTransaction = async (
  transaction: Transaction,
  sequelizeTransaction?: SequelizeTransaction,
): Promise<Expense | null> => {
  if (!transaction.ExpenseId) {
    return null;
  }
  return models.Expense.findByPk(transaction.ExpenseId, { transaction: sequelizeTransaction });
};

const findExistingPaymentIntent = async (
  { order, expense }: UpsertPaymentIntentSource,
  sequelizeTransaction?: SequelizeTransaction,
): Promise<PaymentIntent | null> => {
  if (order?.id) {
    return PaymentIntent.findOne({ where: { OrderId: order.id }, transaction: sequelizeTransaction });
  }
  if (expense?.id) {
    return PaymentIntent.findOne({ where: { ExpenseId: expense.id }, transaction: sequelizeTransaction });
  }
  return null;
};

export const resolveSharedParentCollectiveId = async (
  payerCollectiveId: number | null,
  payeeCollectiveId: number | null,
  sequelizeTransaction?: SequelizeTransaction,
): Promise<number | null> => {
  if (!payerCollectiveId || !payeeCollectiveId) {
    return null;
  } else if (payerCollectiveId === payeeCollectiveId) {
    return payerCollectiveId;
  }

  const collectives = await Collective.findAll({
    where: { id: [payerCollectiveId, payeeCollectiveId] },
    attributes: ['id', 'ParentCollectiveId'],
    transaction: sequelizeTransaction,
  });

  const payer = collectives.find(c => c.id === payerCollectiveId);
  const payee = collectives.find(c => c.id === payeeCollectiveId);
  if (!payer || !payee) {
    return null;
  }

  if (payer.id === payee.ParentCollectiveId) {
    return payer.id;
  } else if (payee.id === payer.ParentCollectiveId) {
    return payee.id;
  } else if (
    payer.ParentCollectiveId &&
    payee.ParentCollectiveId &&
    payer.ParentCollectiveId === payee.ParentCollectiveId
  ) {
    return payer.ParentCollectiveId;
  }

  return null;
};

const findPrimaryTransactionForGroup = async (
  transactionGroup: string,
  sequelizeTransaction?: SequelizeTransaction,
): Promise<Transaction | null> => {
  const transactions = await Transaction.findAll({
    where: { TransactionGroup: transactionGroup, isRefund: false },
    transaction: sequelizeTransaction,
    order: [['id', 'ASC']],
  });

  return (
    transactions.find(t => isPrimaryTransactionKind(t.kind)) ??
    transactions.find(t => t.type === 'CREDIT') ??
    transactions[0] ??
    null
  );
};

const linkTransactionsToPaymentIntent = async (
  paymentIntentId: number,
  transactionGroup: string,
  sequelizeTransaction?: SequelizeTransaction,
): Promise<void> => {
  await Transaction.update(
    { PaymentIntentId: paymentIntentId },
    {
      where: { TransactionGroup: transactionGroup },
      transaction: sequelizeTransaction,
    },
  );
};

export const deletePaymentIntentForSource = async (
  source: UpsertPaymentIntentSource,
  sequelizeTransaction?: SequelizeTransaction,
): Promise<void> => {
  const paymentIntent = await findExistingPaymentIntent(source, sequelizeTransaction);
  if (paymentIntent) {
    await paymentIntent.destroy({ transaction: sequelizeTransaction });
  }
};

const _upsertPaymentIntentFor = async (
  source: UpsertPaymentIntentSource,
  { sequelizeTransaction, trigger }: UpsertPaymentIntentOptions,
): Promise<PaymentIntent | null> => {
  if (trigger === 'soft-delete') {
    await deletePaymentIntentForSource(source, sequelizeTransaction);
    return null;
  }

  let { order, expense } = source;
  const { transaction } = source;

  if (trigger === 'ledger') {
    if (!transaction || transaction.isRefund || !isPrimaryTransactionKind(transaction.kind)) {
      return null;
    }
  }

  if (transaction && !order && transaction.OrderId) {
    order = await loadOrderForTransaction(transaction, sequelizeTransaction);
  }
  if (transaction && !expense && transaction.ExpenseId) {
    expense = await loadExpenseForTransaction(transaction, sequelizeTransaction);
  }

  if (!order && !expense) {
    return null;
  }

  if (order && !order.paymentMethod && order.PaymentMethodId) {
    order.paymentMethod = await order.getPaymentMethod({ transaction: sequelizeTransaction });
  }

  const existing = await findExistingPaymentIntent({ order, expense }, sequelizeTransaction);

  let primaryTransactionGroup = existing?.primaryTransactionGroup ?? null;
  let primaryTransaction: Transaction | null = transaction ?? null;

  if (trigger === 'ledger' && transaction) {
    primaryTransactionGroup = transaction.TransactionGroup;
    primaryTransaction = transaction;
  } else if (primaryTransactionGroup && !primaryTransaction) {
    primaryTransaction = await findPrimaryTransactionForGroup(primaryTransactionGroup, sequelizeTransaction);
  }

  const parties = mapPaymentIntentParties({ order, expense, transaction: primaryTransaction });

  if (order && !parties.HostCollectiveId) {
    const collective = order.collective ?? (await order.getCollective({ transaction: sequelizeTransaction }));
    const host = collective ? await collective.getHostCollective({ transaction: sequelizeTransaction }) : null;
    parties.HostCollectiveId = host?.id ?? collective?.HostCollectiveId ?? null;
  }

  const sharedParentCollectiveId = await resolveSharedParentCollectiveId(
    parties.PayerCollectiveId,
    parties.PayeeCollectiveId,
    sequelizeTransaction,
  );

  const isReversed = trigger === 'refund' || existing?.status === PaymentIntentStatus.REVERSED;

  if (trigger === 'refund') {
    if (!existing) {
      return null;
    }
    await existing.update({ status: PaymentIntentStatus.REVERSED }, { transaction: sequelizeTransaction });
    if (transaction?.TransactionGroup) {
      await linkTransactionsToPaymentIntent(existing.id, transaction.TransactionGroup, sequelizeTransaction);
    }
    return existing;
  }

  const mappingInput: PaymentIntentMappingInput = {
    order,
    expense,
    transaction: primaryTransaction,
    primaryTransactionGroup,
    isReversed,
    sharedParentCollectiveId,
  };

  const status = mapPaymentIntentStatus(mappingInput);

  const paidAt =
    existing?.paidAt && status === PaymentIntentStatus.REVERSED
      ? existing.paidAt
      : (mapPaymentIntentPaidAt({
          ...mappingInput,
          status,
          primaryTransaction,
        }) ?? (primaryTransaction ? (primaryTransaction.clearedAt ?? primaryTransaction.createdAt) : null));

  const payload = {
    primaryTransactionGroup,
    status,
    type: mapPaymentIntentType(mappingInput),
    ...parties,
    description: mapPaymentIntentDescription({ order, expense, transaction: primaryTransaction }),
    paidAt: status === PaymentIntentStatus.PENDING || status === PaymentIntentStatus.ERROR ? null : paidAt,
    OrderId: order?.id ?? null,
    ExpenseId: expense?.id ?? null,
  };

  let paymentIntent: PaymentIntent;
  if (existing) {
    await existing.update(payload, { transaction: sequelizeTransaction });
    paymentIntent = existing;
  } else {
    paymentIntent = await PaymentIntent.create(payload, { transaction: sequelizeTransaction });
  }

  if (primaryTransactionGroup) {
    await linkTransactionsToPaymentIntent(paymentIntent.id, primaryTransactionGroup, sequelizeTransaction);
  }

  return paymentIntent;
};

// PaymentIntents are in internal beta, an error in the upsert should not fail the entire operation.
// Better error handling should be implemented in the future.
const upsertPaymentIntentFor = async (
  source: UpsertPaymentIntentSource,
  { sequelizeTransaction, trigger }: UpsertPaymentIntentOptions,
): Promise<PaymentIntent | null> => {
  try {
    return await _upsertPaymentIntentFor(source, { sequelizeTransaction, trigger });
  } catch (error) {
    reportErrorToSentry(error, { extra: { source, trigger } });
    return null;
  }
};

export const syncPaymentIntentFromOrder = async (
  order: Order,
  sequelizeTransaction?: SequelizeTransaction,
): Promise<PaymentIntent | null> => upsertPaymentIntentFor({ order }, { sequelizeTransaction, trigger: 'lifecycle' });

export const syncPaymentIntentFromExpense = async (
  expense: Expense,
  sequelizeTransaction?: SequelizeTransaction,
): Promise<PaymentIntent | null> => upsertPaymentIntentFor({ expense }, { sequelizeTransaction, trigger: 'lifecycle' });

export const syncPaymentIntentFromLedgerTransaction = async (
  transaction: Transaction,
  sequelizeTransaction?: SequelizeTransaction,
): Promise<PaymentIntent | null> =>
  upsertPaymentIntentFor({ transaction }, { sequelizeTransaction, trigger: 'ledger' });

export const syncPaymentIntentFromRefund = async (
  transaction: Transaction,
  sequelizeTransaction?: SequelizeTransaction,
): Promise<PaymentIntent | null> =>
  upsertPaymentIntentFor({ transaction }, { sequelizeTransaction, trigger: 'refund' });

/** Backfill entrypoint: propagates errors (unlike production sync wrappers). */
export const backfillPaymentIntentFromSource = async (
  source: UpsertPaymentIntentSource,
  {
    sequelizeTransaction,
    trigger,
  }: {
    sequelizeTransaction?: SequelizeTransaction;
    trigger: BackfillPaymentIntentTrigger;
  },
): Promise<PaymentIntent | null> => _upsertPaymentIntentFor(source, { sequelizeTransaction, trigger });
