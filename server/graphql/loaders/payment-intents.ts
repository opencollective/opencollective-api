import DataLoader from 'dataloader';
import express from 'express';
import { sql } from 'kysely';
import { groupBy, isNil, keyBy } from 'lodash';

import { SupportedCurrency } from '../../constants/currencies';
import { TransactionTypes } from '../../constants/transactions';
import { getKysely } from '../../lib/kysely';
import models from '../../models';
import PaymentIntent from '../../models/PaymentIntent';
import Transaction from '../../models/Transaction';
import { GraphQLAmountFields } from '../v2/object/Amount';

import { sortResultsSimple } from './helpers';

/**
 * Loader for transactions linked to a payment intent.
 */
export const generatePaymentIntentTransactionsLoader = (): DataLoader<number, Transaction[]> =>
  new DataLoader(async (paymentIntentIds: number[]) => {
    const transactions = await models.Transaction.findAll({
      where: { PaymentIntentId: paymentIntentIds },
      order: [['id', 'ASC']],
    });

    const transactionsByPaymentIntentId = groupBy(transactions, 'PaymentIntentId');
    return paymentIntentIds.map(id => transactionsByPaymentIntentId[id] || []);
  });

/**
 * Loader for payment intents by legacy numeric id.
 */
export const generatePaymentIntentByIdLoader = (): DataLoader<number, PaymentIntent> =>
  new DataLoader(async (ids: number[]) => {
    const paymentIntents = await PaymentIntent.findAll({ where: { id: ids } });
    return sortResultsSimple(ids, paymentIntents);
  });

type PaymentIntentAmountRow = {
  id: number;
  value: string | number | null;
  currency: SupportedCurrency | null;
  hostCollectiveCurrency?: SupportedCurrency | null;
};

/** Maps raw query rows to GraphQL amount fields, preserving DataLoader key order. */
const mapAmountResults = (ids: readonly number[], rows: PaymentIntentAmountRow[]): GraphQLAmountFields[] => {
  const amountsById = keyBy(rows, 'id');
  return ids.map(id => {
    const row = amountsById[id];
    if (isNil(row) || isNil(row.value) || isNil(row.currency)) {
      return null;
    } else {
      return { value: Number(row.value), currency: row.currency };
    }
  });
};

/**
 * Sums transaction amounts per payment intent, converting each row to the host collective currency.
 * Used by amountSent/amountReceived loaders after the Kysely query returns per-currency aggregates.
 */
const aggregateTransactionAmountResults = async (
  req: express.Request,
  ids: readonly number[],
  rows: PaymentIntentAmountRow[],
): Promise<(GraphQLAmountFields | null)[]> => {
  const rowsById = groupBy(rows, 'id');

  return Promise.all(
    ids.map(async id => {
      const idRows = rowsById[id];
      const hostCollectiveCurrency = idRows?.[0]?.hostCollectiveCurrency;
      if (isNil(hostCollectiveCurrency)) {
        return null;
      }

      const validRows = idRows.filter(row => !isNil(row.value) && !isNil(row.currency));
      if (!validRows.length) {
        return null;
      }

      let total = 0;
      for (const { value, currency } of validRows) {
        const amount = Number(value);
        total +=
          currency === hostCollectiveCurrency
            ? amount
            : await req.loaders.CurrencyExchangeRate.convert.load({
                amount,
                fromCurrency: currency,
                toCurrency: hostCollectiveCurrency,
              });
      }

      return { value: total, currency: hostCollectiveCurrency };
    }),
  );
};

/** Loads the intended amount from the linked order or expense (whichever is set). */
const loadPaymentIntentAmountPledged = async (
  paymentIntentIds: readonly number[],
): Promise<PaymentIntentAmountRow[]> => {
  return getKysely()
    .selectFrom('PaymentIntents')
    .leftJoin('Orders', join =>
      join.onRef('Orders.id', '=', 'PaymentIntents.OrderId').on('Orders.deletedAt', 'is', null),
    )
    .leftJoin('Expenses', join =>
      join.onRef('Expenses.id', '=', 'PaymentIntents.ExpenseId').on('Expenses.deletedAt', 'is', null),
    )
    .select([
      'PaymentIntents.id as id',
      eb =>
        eb
          .case()
          .when('PaymentIntents.OrderId', 'is not', null)
          .then(eb.ref('Orders.totalAmount'))
          .else(eb.ref('Expenses.amount'))
          .end()
          .as('value'),
      eb =>
        eb
          .case()
          .when('PaymentIntents.OrderId', 'is not', null)
          .then(eb.ref('Orders.currency'))
          .else(eb.ref('Expenses.currency'))
          .end()
          .as('currency'),
    ])
    .where('PaymentIntents.id', 'in', paymentIntentIds)
    .where('PaymentIntents.deletedAt', 'is', null)
    .execute();
};

/**
 * Aggregates linked transaction amounts in host currency for a payment intent.
 *
 * - `type` DEBIT + PayerCollectiveId: money sent by the payer (amountSent)
 * - `type` CREDIT + PayeeCollectiveId: money received by the payee (amountReceived)
 * - `net`: when true, includes platform, host, payment processor fees and taxes on top of amountInHostCurrency
 *
 * Only non-refunded, non-deleted transactions whose CollectiveId matches the payer or payee are included.
 */
const loadPaymentIntentTransactionAmountsInHostCurrency = async (
  paymentIntentIds: readonly number[],
  {
    net,
    type,
    collectiveIdColumn,
  }: {
    net: boolean;
    type: typeof TransactionTypes.DEBIT | typeof TransactionTypes.CREDIT;
    collectiveIdColumn: 'PayerCollectiveId' | 'PayeeCollectiveId';
  },
): Promise<PaymentIntentAmountRow[]> => {
  return getKysely()
    .selectFrom('Transactions')
    .innerJoin('PaymentIntents', join =>
      join.onRef('PaymentIntents.id', '=', 'Transactions.PaymentIntentId').on('PaymentIntents.deletedAt', 'is', null),
    )
    .leftJoin('Collectives as HostCollective', join =>
      join
        .onRef('HostCollective.id', '=', 'PaymentIntents.HostCollectiveId')
        .on('HostCollective.deletedAt', 'is', null),
    )
    .select([
      'Transactions.PaymentIntentId as id',
      eb => {
        const amountFieldSql = !net
          ? eb.ref('Transactions.amountInHostCurrency')
          : sql<number>`
              COALESCE(${eb.ref('Transactions.amountInHostCurrency')}, 0) +
              COALESCE(${eb.ref('Transactions.platformFeeInHostCurrency')}, 0) +
              COALESCE(${eb.ref('Transactions.hostFeeInHostCurrency')}, 0) +
              COALESCE(${eb.ref('Transactions.paymentProcessorFeeInHostCurrency')}, 0) +
              COALESCE(${eb.ref('Transactions.taxAmount')} * ${eb.ref('Transactions.hostCurrencyFxRate')}, 0)
            `;

        return eb.fn.sum<number>(eb.fn<number>('abs', [amountFieldSql])).as('value');
      },
      'Transactions.hostCurrency as currency',
      'HostCollective.currency as hostCollectiveCurrency',
    ])
    .where('Transactions.deletedAt', 'is', null)
    .where('Transactions.RefundTransactionId', 'is', null)
    .where('Transactions.isRefund', 'is not', true)
    .where('Transactions.PaymentIntentId', 'in', paymentIntentIds)
    .where('Transactions.type', '=', type)
    .where(({ eb }) => {
      const paymentIntentCollectiveId =
        collectiveIdColumn === 'PayerCollectiveId'
          ? eb.ref('PaymentIntents.PayerCollectiveId')
          : eb.ref('PaymentIntents.PayeeCollectiveId');
      return eb('Transactions.CollectiveId', '=', paymentIntentCollectiveId);
    })
    .groupBy(['Transactions.PaymentIntentId', 'Transactions.hostCurrency', 'HostCollective.currency'])
    .execute();
};

/**
 * Loader for the pledged amount (order total or expense amount) in its native currency.
 * Currency conversion to payer/payee/host is handled by the GraphQL amountPledged resolver.
 */
export const generatePaymentIntentAmountPledgedLoader = (): DataLoader<number, GraphQLAmountFields> =>
  new DataLoader(async (paymentIntentIds: number[]) => {
    const rows = await loadPaymentIntentAmountPledged(paymentIntentIds);
    return mapAmountResults(paymentIntentIds, rows);
  });

/**
 * Loader for the total amount sent by the payer, expressed in host currency.
 * Pass `net: true` to include fees and taxes recorded on linked debit transactions.
 */
export const generatePaymentIntentAmountSentInHostCurrencyLoader = (
  req: express.Request,
  net: boolean,
): DataLoader<number, GraphQLAmountFields> =>
  new DataLoader(async (paymentIntentIds: number[]) => {
    const rows = await loadPaymentIntentTransactionAmountsInHostCurrency(paymentIntentIds, {
      net,
      type: TransactionTypes.DEBIT,
      collectiveIdColumn: 'PayerCollectiveId',
    });
    return aggregateTransactionAmountResults(req, paymentIntentIds, rows);
  });

/**
 * Loader for the total amount received by the payee, expressed in host currency.
 * Pass `net: true` to include fees and taxes recorded on linked credit transactions.
 */
export const generatePaymentIntentAmountReceivedInHostCurrencyLoader = (
  req: express.Request,
  net: boolean,
): DataLoader<number, GraphQLAmountFields> =>
  new DataLoader(async (paymentIntentIds: number[]) => {
    const rows = await loadPaymentIntentTransactionAmountsInHostCurrency(paymentIntentIds, {
      net,
      type: TransactionTypes.CREDIT,
      collectiveIdColumn: 'PayeeCollectiveId',
    });
    return aggregateTransactionAmountResults(req, paymentIntentIds, rows);
  });
