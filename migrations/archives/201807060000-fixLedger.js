/* This migration is archived */

/* This migration is commented becaused it contained live code that is not supported anynmore */

/*

'use strict';

const DRY_MODE = false;
import Promise from 'bluebird';
import nock from 'nock';
import moment from 'moment';
import { get } from 'lodash';
import { getFxRate } from '../server/lib/currency';

if (process.env.RECORD) {
  nock.recorder.rec();
}

let transactionsFixed = 0;
let transactionsUpdated = 0;
let failedUpdates = 0;
let warnings = 0;
let invalidTransactions = 0;
let transactionsProcessed = 0;
const queries = [];
const errorsObject = {};

const updateLedgerEntry = (transaction, updateData) => {
  transactionsUpdated++;
  const newTransaction = {
    ...transaction,
    ...updateData,
    data: JSON.stringify(transaction.data),
    updatedAt: new Date(),
  };

  delete newTransaction.collective;
  delete newTransaction.host;
  delete newTransaction.hostCollectiveCurrency;
  delete newTransaction.id;
  const query = `
  BEGIN;
  UPDATE "Transactions" SET "deletedAt"=:transaction_deletedAt WHERE id=:transaction_id;
  INSERT INTO "Transactions" ("${Object.keys(newTransaction).join('","')}") VALUES (:${Object.keys(newTransaction).join(
    ',:',
  )});
  COMMIT;`;
  if (DRY_MODE) {
    // console.log(">>> updateLedgerEntry", newTransaction);
    // console.log(query);
    return;
  }
  queries.push({
    query,
    replacements: {
      ...newTransaction,
      transaction_id: transaction.id,
      transaction_deletedAt: new Date(),
    },
  });
};

const addPaymentProcessorFee = transaction => {
  switch (transaction.type) {
    case 'DEBIT':
      if (
        transaction.netAmountInCollectiveCurrency !=
        transaction.amount + transaction.paymentProcessorFeeInHostCurrency
      ) {
        const newNetAmount = transaction.amount + transaction.paymentProcessorFeeInHostCurrency;
        // console.log(">>> addPaymentProcessorFee", transaction.type, "id", transaction.id, "amount:", transaction.amount, transaction.currency, "paymentProcessorFee:", transaction.paymentProcessorFeeInHostCurrency, transaction.hostCurrency, "net amount:", transaction.netAmountInCollectiveCurrency, "new net amount: ", newNetAmount);
        return { netAmountInCollectiveCurrency: newNetAmount };
      }
      break;
    case 'CREDIT':
      if (
        transaction.amount !=
        transaction.netAmountInCollectiveCurrency - transaction.paymentProcessorFeeInHostCurrency
      ) {
        const newAmount = transaction.netAmountInCollectiveCurrency - transaction.paymentProcessorFeeInHostCurrency;
        // console.log(">>> addPaymentProcessorFee", transaction.type, "id", transaction.id, "amount:", transaction.amount, transaction.currency, "paymentProcessorFee:", transaction.paymentProcessorFeeInHostCurrency, transaction.hostCurrency, "net amount:", transaction.netAmountInCollectiveCurrency, "new amount: ", newAmount);
        return { amount: newAmount };
      }
      break;
  }
};

const verifyTransaction = (tr, accuracy = 0) => {
  if (tr.hostCollectiveCurrency && tr.hostCurrency !== tr.hostCollectiveCurrency) return false; // if there is a discrepency between tr.hostCurrency and tr.host.currency
  if (tr.currency !== tr.hostCurrency) {
    if (!tr.hostCurrencyFxRate || tr.hostCurrencyFxRate === 1) return false;
  }
  if (tr.hostFeeInHostCurrency > 0 || tr.platformFeeInHostCurrency > 0 || tr.paymentProcessorFeeInHostCurrency > 0) {
    return false;
  }
  const fees = tr.hostFeeInHostCurrency + tr.platformFeeInHostCurrency + tr.paymentProcessorFeeInHostCurrency || 0;
  const netAmountInCollectiveCurrency = Math.round((tr.amountInHostCurrency + fees) / tr.hostCurrencyFxRate);
  if (netAmountInCollectiveCurrency === tr.netAmountInCollectiveCurrency) {
    return true;
  } else {
    if (relativeDiffInPercentage(netAmountInCollectiveCurrency, tr.netAmountInCollectiveCurrency) < accuracy) {
      // console.log(">>> ", tr.id, "netAmountInCollectiveCurrency != tr.netAmountInCollectiveCurrency by ", relativeDiffInPercentage(netAmountInCollectiveCurrency, tr.netAmountInCollectiveCurrency));
      return true;
    } else {
      return false;
    }
  }
};

const cols = [
  'date',
  'host',
  'host.currency',
  'collective',
  'type',
  'transaction.amount',
  'transaction.currency',
  'amountInHostCurrency',
  'update',
  'delta',
  'hostCurrency',
  'hostCurrencyFxRate',
  'newHostCurrencyFxRate',
  'hostFeeInHostCurrency',
  'platformFeeInHostCurrency',
  'paymentProcessorFeeInHostcurrency',
  'totalFeesInCollectiveCurrency',
  'netAmountInCollectiveCurrency',
  'update',
  'delta',
  'OrderId',
  'ExpenseId',
  'TransactionGroup',
  'reason',
  'fix',
  'fixValid',
];
console.log(cols.join('|'));

const relativeDiffInPercentage = (a, b) => {
  return Math.abs(Math.round((Math.abs(a - b) / Math.min(a, b)) * 10000) / 10000);
};

const isRefundTransaction = tr => {
  if (!tr.RefundTransactionId) return false;
  return tr.description.match(/^Refund of /);
};

const fixTransaction = async tr => {
  transactionsProcessed++;
  if (!tr) return;
  if (verifyTransaction(tr)) {
    return;
  }
  invalidTransactions++;

  let update = {},
    newFxRate,
    reasons = [];

  if (tr.ExpenseId && tr.paymentProcessorFeeInHostCurrency < 0) {
    reasons.push('payment processor fee not accounted for');
    update = addPaymentProcessorFee(tr) || {};
  }

  if (tr.hostFeeInHostCurrency > 0 && !isRefundTransaction(tr)) {
    reasons.push('hostFeeInHostCurrency should be negative');
    update.hostFeeInHostCurrency = -tr.hostFeeInHostCurrency;
  }
  if (tr.platformFeeInHostCurrency > 0 && !isRefundTransaction(tr)) {
    reasons.push('platformFeeInHostCurrency should be negative');
    update.platformFeeInHostCurrency = -tr.platformFeeInHostCurrency;
  }
  if (tr.paymentProcessorFeeInHostCurrency > 0 && !isRefundTransaction(tr)) {
    reasons.push('paymentProcessorFeeInHostCurrency should be negative');
    update.paymentProcessorFeeInHostCurrency = -tr.paymentProcessorFeeInHostCurrency;
  }

  const stripeAccountCurrency = get(tr, 'data.balanceTransaction.currency');
  if (stripeAccountCurrency) {
    if (stripeAccountCurrency != (tr.hostCurrency || '').toLowerCase()) {
      reasons.push("hostCurrency doesn't match Stripe account currency");
      update.hostCurrency = stripeAccountCurrency.toUpperCase();
    }
  } else if (!tr.hostCurrency) {
    reasons.push('missing host currency');
    if (tr.hostCollectiveCurrency) {
      update.hostCurrency = tr.hostCollectiveCurrency;
    }
  } else if (tr.hostCollectiveCurrency && tr.hostCurrency !== tr.hostCollectiveCurrency) {
    reasons.push("hostCurrency doesn't match host.currency");
    update.hostCurrency = tr.hostCollectiveCurrency;
  }

  if (update.hostCurrency) {
    tr.hostCurrency = update.hostCurrency;
  }

  if (!tr.hostCollectiveCurrency) {
    errorsObject[tr.HostCollectiveId] = `${tr.host} (id: ${tr.HostCollectiveId}) doesn't have a currency set`;
  } else if (tr.hostCurrency !== tr.hostCollectiveCurrency) {
    errorsObject[tr.HostCollectiveId] = `${tr.host} (id: ${tr.HostCollectiveId}) has a wrong currency set (${
      tr.hostCollectiveCurrency
    }, should be ${tr.hostCurrency})`;
  }

  // fix amount in host currency for transactions in the same currency
  if (tr.currency === tr.hostCurrency) {
    if (tr.hostCurrencyFxRate !== 1) {
      reasons.push('invalid hostCurrencyFxRate');
      update.hostCurrencyFxRate = 1;
    }
    if (tr.amount !== tr.amountInHostCurrency) {
      reasons.push('invalid amountInHostCurrency');
      update.amountInHostCurrency = tr.amount;
    }
  } else {
    try {
      newFxRate = await getFxRate(tr.currency, tr.hostCurrency, tr.createdAt);
      // if there wasn't any fxrate before, we record it
      if (!tr.hostCurrencyFxRate || tr.hostCurrencyFxRate === 1) {
        reasons.push('no hostCurrencyFxRate');
        update.hostCurrencyFxRate = newFxRate;
      } else if (relativeDiffInPercentage(tr.hostCurrencyFxRate, newFxRate) < 0.1) {
        // if tr.hostCurrencyFxRate is ~= newFxRate, no need to change it, but we need to verify that tr.amountInHostCurrency was correctly computed
        const amountInHostCurrency = Math.round(tr.amount * tr.hostCurrencyFxRate);
        if (tr.amountInHostCurrency != amountInHostCurrency) {
          reasons.push('amountInHostCurrency off');
          update.amountInHostCurrency = amountInHostCurrency;
        }
      } else if (relativeDiffInPercentage(tr.hostCurrencyFxRate, 1 / newFxRate) < 0.1) {
        // if hostCurrencyFxRate ~= 1/newFxRate, then it was in the wrong direction => we flip it
        update.hostCurrencyFxRate = 1 / tr.hostCurrencyFxRate;
        reasons.push('hostCurrencyFxRate flipped');
      } else {
        const diff = relativeDiffInPercentage(tr.hostCurrencyFxRate, Math.abs(tr.amountInHostCurrency / tr.amount));
        // if diff is very small (< 10%)
        if (diff < 0.1) {
          reasons.push(`imprecise fx rate (diff ${diff})`);
          update.hostCurrencyFxRate = Math.abs(tr.amountInHostCurrency / tr.amount);
        } else {
          update.hostCurrencyFxRate = newFxRate;
          reasons.push(`hostCurrencyFxRate off (diff ${diff})`);
        }
      }
    } catch (e) {
      console.error(
        `Unable to fetch fxrate for transaction id ${tr.id} from ${tr.currency} to ${tr.hostCurrency}, date: ${
          tr.createdAt
        }`,
        e,
      );
    }
  }
  const newAmountInHostCurrency = Math.round(tr.amount * update.hostCurrencyFxRate);
  if (update.hostCurrencyFxRate && newAmountInHostCurrency !== tr.amountInHostCurrency) {
    update.amountInHostCurrency = newAmountInHostCurrency;
    // if we change the amountInHostCurrency, we need to recompute the hostFees and platformFees since they were computed based on that amount.
    if (
      tr.platformFeeInHostCurrency < 0 &&
      tr.platformFeeInHostCurrency !== -Math.round(0.05 * Math.abs(update.amountInHostCurrency))
    ) {
      update.platformFeeInHostCurrency = -Math.round(0.05 * Math.abs(update.amountInHostCurrency));
    }
    const hostFeePercent = Math.abs(Math.round((tr.hostFeeInHostCurrency / tr.amountInHostCurrency) * 100) / 100);
    if (
      tr.hostFeeInHostCurrency < 0 &&
      tr.hostFeeInHostCurrency !== -Math.abs(Math.round(hostFeePercent * update.amountInHostCurrency))
    ) {
      update.hostFeeInHostCurrency = -Math.abs(Math.round(hostFeePercent * update.amountInHostCurrency));
    }
  }

  const newTransaction = {
    ...tr,
    ...update,
  };

  const totalFeesInCollectiveCurrency = Math.round(
    (newTransaction.hostFeeInHostCurrency +
      newTransaction.platformFeeInHostCurrency +
      newTransaction.paymentProcessorFeeInHostCurrency || 0) / newTransaction.hostCurrencyFxRate,
  );
  const diff = Math.abs(
    totalFeesInCollectiveCurrency + newTransaction.amount - newTransaction.netAmountInCollectiveCurrency,
  );
  if (diff > 0) {
    reasons.push(`amount + fees != netAmount; diff: ${diff}`);
  }

  newTransaction.hostCollectiveCurrency = newTransaction.hostCurrency; // make sure verify doesn't fail because hostCollective.currency is not set
  const fixValid = verifyTransaction(newTransaction, 0.01);
  if (fixValid) {
    transactionsFixed++;
  }
  if (
    relativeDiffInPercentage(tr.amountInHostCurrency, update.amountInHostCurrency) > 0.1 ||
    Math.abs(tr.amountInHostCurrency - update.amountInHostCurrency) > 500
  ) {
    warnings++;
    console.error(
      `warning: tr ${tr.id} amountInHostCurrency is changing from ${tr.amountInHostCurrency} to ${
        update.amountInHostCurrency
      }`,
    );
  }
  if (
    relativeDiffInPercentage(tr.netAmountInCollectiveCurrency, update.netAmountInCollectiveCurrency) > 0.1 ||
    Math.abs(tr.netAmountInCollectiveCurrency - update.netAmountInCollectiveCurrency) > 500
  ) {
    warnings++;
    console.error(
      `warning: tr ${tr.id} netAmountInCollectiveCurrency is changing from ${tr.netAmountInCollectiveCurrency} to ${
        update.netAmountInCollectiveCurrency
      }`,
    );
  }
  if (tr.hostCurrencyFxRate !== 1 && relativeDiffInPercentage(tr.hostCurrencyFxRate, update.hostCurrencyFxRate) > 0.1) {
    warnings++;
    console.error(
      `warning: tr ${tr.id} hostCurrencyFxRate is changing from ${tr.hostCurrencyFxRate} to ${
        update.hostCurrencyFxRate
      }`,
    );
  }
  const netAmountDelta =
    update.netAmountInCollectiveCurrency &&
    Math.abs(tr.netAmountInCollectiveCurrency - update.netAmountInCollectiveCurrency);
  const amountInHostCurrencyDelta =
    update.amountInHostCurrency && Math.abs(tr.amountInHostCurrency - update.amountInHostCurrency);
  if (DRY_MODE) {
    const vals = [
      moment(tr.createdAt).format('YYYY-MM-DD HH:mm:ss'),
      tr.host,
      tr.hostCollectiveCurrency,
      tr.collective,
      tr.type,
      tr.amount,
      tr.currency,
      tr.amountInHostCurrency,
      update.amountInHostCurrency,
      amountInHostCurrencyDelta,
      tr.hostCurrency,
      tr.hostCurrencyFxRate,
      update.hostCurrencyFxRate,
      tr.hostFeeInHostCurrency,
      tr.platformFeeInHostCurrency,
      tr.paymentProcessorFeeInHostCurrency,
      totalFeesInCollectiveCurrency,
      tr.netAmountInCollectiveCurrency,
      update.netAmountInCollectiveCurrency,
      netAmountDelta,
      tr.OrderId,
      tr.ExpenseId,
      tr.TransactionGroup,
      reasons.join(', '),
      JSON.stringify(update),
      fixValid,
    ];
    console.log(vals.join('|'));
  } else {
    return updateLedgerEntry(tr, update);
  }
};

module.exports = {
  up: (queryInterface, sequelize) => {
    // We need to remove the index on UUID. It should be unique per deletedAt (only one unique UUID that has not been removed)
    // otherwise, we can't delete current transaction row to create a new updated one with the same UUID
    return (
      queryInterface
        .removeIndex('Transactions', 'transactions_uuid')
        .then(() =>
          queryInterface.addIndex('Transactions', ['uuid', 'deletedAt'], {
            indexName: 'transactions_uuid',
            indicesType: 'UNIQUE',
          }),
        )
        // fix transactions where currency != hostCurrency
        .then(() =>
          queryInterface.sequelize.query(
            `
      SELECT t.*, hc.slug as "host", hc.currency as "hostCollectiveCurrency", c.slug as "collective" FROM "Transactions" t
      LEFT JOIN "Collectives" c ON c.id = t."CollectiveId"
      LEFT JOIN "Collectives" hc ON hc.id = t."HostCollectiveId"
      WHERE t."deletedAt" IS NULL
    `,
            { type: sequelize.QueryTypes.SELECT },
          ),
        )
        .map(fixTransaction)
        .then(() => {
          console.log('>>>', transactionsProcessed, 'transactions processed');
          console.log(
            `>>> ${invalidTransactions} invalid transactions (${Math.round(
              (invalidTransactions / transactionsProcessed) * 10000,
            ) / 100}%)`,
          );
          console.log(
            `>>> Updating ${transactionsUpdated} transactions (${Math.round(
              (transactionsUpdated / invalidTransactions) * 10000,
            ) / 100}%)`,
          );
          console.log(
            `>>> Fixing ${transactionsFixed} transactions (${Math.round(
              (transactionsFixed / invalidTransactions) * 10000,
            ) / 100}%)`,
          );
          console.log('>>>', warnings, 'warnings');
          if (Object.keys(errorsObject).length > 0) {
            for (let key in errorsObject) {
              console.error(errorsObject[key]);
            }
          }
          if (DRY_MODE) {
            queries.map(q => console.log('> query:', q.query, 'replacements:', JSON.stringify(q.replacements)));
            throw new Error('Success!');
          } else {
            console.log('>>> running', queries.length, 'queries');
            return Promise.map(
              queries,
              query =>
                queryInterface.sequelize.query(query.query, { replacements: query.replacements }).catch(e => {
                  failedUpdates++;
                  console.log('>>> error: ', JSON.stringify(e, null, '  '));
                }),
              { concurrency: 2 },
            );
          }
        })
        .then(() => {
          console.log(`>>> ${failedUpdates} queries returned an error`);
        })
    );
  },

  down: (queryInterface, Sequelize) => {
    return Promise.resolve(); // No way to revert this
  },
};

*/
