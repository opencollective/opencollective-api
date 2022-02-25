import { round, set, toNumber, truncate } from 'lodash';

import ExpenseType from '../constants/expense_type';
import TierType from '../constants/tiers';
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';
import { getFxRate } from '../lib/currency';
import errors from '../lib/errors';
import { toNegative } from '../lib/math';
import { exportToCSV } from '../lib/utils';
import models, { Op, sequelize } from '../models';
import { PayoutMethodTypes } from '../models/PayoutMethod';

const { CREDIT, DEBIT } = TransactionTypes;
const { ADDED_FUNDS, CONTRIBUTION, EXPENSE } = TransactionKind;
const { TICKET } = TierType;
const { CHARGE } = ExpenseType;

/**
 * Export transactions as CSV
 * @param {*} transactions
 */
export function exportTransactions(transactions, attributes) {
  attributes = attributes || [
    'id',
    'createdAt',
    'amount',
    'currency',
    'description',
    'netAmountInCollectiveCurrency',
    'hostCurrency',
    'hostCurrencyFxRate',
    'paymentProcessorFeeInHostCurrency',
    'hostFeeInHostCurrency',
    'platformFeeInHostCurrency',
    'netAmountInHostCurrency',
  ];

  return exportToCSV(transactions, attributes);
}

/**
 * Get transactions between startDate and endDate for collectiveids
 * @param {*} collectiveids
 * @param {*} startDate
 * @param {*} endDate
 * @param {*} limit
 */
export function getTransactions(collectiveids, startDate = new Date('2015-01-01'), endDate = new Date(), options) {
  const where = options.where || {};
  const query = {
    where: {
      ...where,
      CollectiveId: { [Op.in]: collectiveids },
      createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
    },
    order: [['createdAt', 'DESC']],
  };
  if (options.limit) {
    query.limit = options.limit;
  }
  if (options.include) {
    query.include = options.include;
  }
  return models.Transaction.findAll(query);
}

export async function createFromPaidExpense(
  host,
  paymentMethod,
  expense,
  paymentResponses,
  UserId,
  paymentProcessorFeeInHostCurrency = 0,
  hostFeeInHostCurrency = 0,
  platformFeeInHostCurrency = 0,
  transactionData,
) {
  const hostCurrency = host.currency;
  let createPaymentResponse, executePaymentResponse;
  let paymentProcessorFeeInCollectiveCurrency = 0,
    hostFeeInCollectiveCurrency = 0,
    platformFeeInCollectiveCurrency = 0;
  let hostCurrencyFxRate = 1;
  const payoutMethod = await expense.getPayoutMethod();
  const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();
  expense.collective = expense.collective || (await models.Collective.findByPk(expense.CollectiveId));
  const isMultiCurrency = expense.collective.currency !== expense.currency;
  let fxRateExpenseToCollective = 1;

  // If PayPal
  if (paymentResponses) {
    createPaymentResponse = paymentResponses.createPaymentResponse;
    executePaymentResponse = paymentResponses.executePaymentResponse;

    switch (executePaymentResponse.paymentExecStatus) {
      case 'COMPLETED':
        break;

      case 'CREATED':
        /*
         * When we don't provide a preapprovalKey (paymentMethod.token) to payServices['paypal'](),
         * it creates a payKey that we can use to redirect the user to PayPal.com to manually approve that payment
         * TODO We should handle that case on the frontend
         */
        throw new errors.BadRequest(
          `Please approve this payment manually on ${createPaymentResponse.paymentApprovalUrl}`,
        );

      case 'ERROR':
        // Backward compatible error message parsing
        // eslint-disable-next-line no-case-declarations
        const errorMessage =
          executePaymentResponse.payErrorList?.payError?.[0].error?.message ||
          executePaymentResponse.payErrorList?.[0].error?.message;
        throw new errors.ServerError(
          `Error while paying the expense with PayPal: "${errorMessage}". Please contact support@opencollective.com or pay it manually through PayPal.`,
        );

      default:
        throw new errors.ServerError(
          `Error while paying the expense with PayPal. Please contact support@opencollective.com or pay it manually through PayPal.`,
        );
    }

    // Warning senderFees can be null
    const senderFees = createPaymentResponse.defaultFundingPlan.senderFees;
    paymentProcessorFeeInCollectiveCurrency = senderFees ? senderFees.amount * 100 : 0; // paypal sends this in float

    const currencyConversion = createPaymentResponse.defaultFundingPlan.currencyConversion || { exchangeRate: 1 };
    hostCurrencyFxRate = 1 / parseFloat(currencyConversion.exchangeRate); // paypal returns a float from host.currency to expense.currency
    paymentProcessorFeeInHostCurrency = Math.round(hostCurrencyFxRate * paymentProcessorFeeInCollectiveCurrency);
    // TODO get expense to collective fx rate
  }
  // PayPal Payouts
  else if (payoutMethodType === PayoutMethodTypes.PAYPAL && transactionData?.payout_batch_id) {
    hostCurrencyFxRate = transactionData.currency_conversion?.exchange_rate
      ? 1 / toNumber(transactionData.currency_conversion?.exchange_rate)
      : await getFxRate(expense.currency, host.currency, expense.incurredAt || expense.createdAt);

    paymentProcessorFeeInCollectiveCurrency = round(toNumber(transactionData.payout_item_fee?.value) * 100);
    paymentProcessorFeeInHostCurrency = Math.round(hostCurrencyFxRate * paymentProcessorFeeInCollectiveCurrency);
    hostFeeInCollectiveCurrency = Math.round((1 / hostCurrencyFxRate) * hostFeeInHostCurrency);
    platformFeeInCollectiveCurrency = Math.round((1 / hostCurrencyFxRate) * platformFeeInHostCurrency);
    // TODO get expense to collective fx rate
  } else if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT) {
    if (host.settings?.transferwise?.ignorePaymentProcessorFees) {
      paymentProcessorFeeInHostCurrency = 0;
    } else if (transactionData?.paymentOption?.fee?.total) {
      paymentProcessorFeeInHostCurrency = Math.round(transactionData.paymentOption.fee.total * 100);
    }
    // Notice this is the FX rate between Host and Collective, the user is not involved here and that's why TransferWise quote rate is irrelevant here.
    hostCurrencyFxRate = await getFxRate(expense.currency, host.currency);
    paymentProcessorFeeInCollectiveCurrency = Math.round((1 / hostCurrencyFxRate) * paymentProcessorFeeInHostCurrency);
    hostFeeInCollectiveCurrency = Math.round((1 / hostCurrencyFxRate) * hostFeeInHostCurrency);
    platformFeeInCollectiveCurrency = Math.round((1 / hostCurrencyFxRate) * platformFeeInHostCurrency);
    // TODO get expense to collective fx rate
  } else {
    // If manual (add funds or manual reimbursement of an expense)
    hostCurrencyFxRate = await getFxRate(
      expense.collective.currency,
      host.currency,
      expense.incurredAt || expense.createdAt,
    );
    fxRateExpenseToCollective = !isMultiCurrency ? 1 : await getFxRate(expense.currency, expense.collective.currency);
    paymentProcessorFeeInCollectiveCurrency = Math.round((1 / hostCurrencyFxRate) * paymentProcessorFeeInHostCurrency);
    hostFeeInCollectiveCurrency = Math.round((1 / hostCurrencyFxRate) * hostFeeInHostCurrency);
    platformFeeInCollectiveCurrency = Math.round((1 / hostCurrencyFxRate) * platformFeeInHostCurrency);
  }

  // We assume that all expenses are in Collective currency
  // (otherwise, ledger breaks with a triple currency conversion)
  const amountInCollectiveCurrency = Math.round(expense.amount * fxRateExpenseToCollective);
  const transaction = {
    netAmountInCollectiveCurrency:
      -1 *
      (amountInCollectiveCurrency +
        paymentProcessorFeeInCollectiveCurrency +
        hostFeeInCollectiveCurrency +
        platformFeeInCollectiveCurrency),
    hostCurrency,
    paymentProcessorFeeInHostCurrency: toNegative(paymentProcessorFeeInHostCurrency),
    hostFeeInHostCurrency: toNegative(hostFeeInHostCurrency),
    platformFeeInHostCurrency: toNegative(platformFeeInHostCurrency),
    ExpenseId: expense.id,
    type: DEBIT,
    kind: EXPENSE,
    amount: -amountInCollectiveCurrency,
    currency: expense.collective.currency,
    description: expense.description,
    CreatedByUserId: UserId,
    CollectiveId: expense.CollectiveId,
    FromCollectiveId: expense.FromCollectiveId,
    HostCollectiveId: host.id,
    PaymentMethodId: paymentMethod ? paymentMethod.id : null,
    data: transactionData,
  };

  transaction.hostCurrencyFxRate = hostCurrencyFxRate;
  transaction.amountInHostCurrency = -Math.round(hostCurrencyFxRate * amountInCollectiveCurrency); // amountInHostCurrency is an INTEGER (in cents)

  // If the payee is assuming the fees, we adapt the amounts
  if (expense.feesPayer === 'PAYEE') {
    transaction.amount += paymentProcessorFeeInCollectiveCurrency;
    transaction.netAmountInCollectiveCurrency += paymentProcessorFeeInCollectiveCurrency;
    transaction.data = set(transaction.data || {}, 'feesPayer', 'PAYEE');
  }

  return models.Transaction.createDoubleEntry(transaction);
}

/**
 * Calculate net amount of a transaction in the currency of the collective
 * Notes:
 * - fees are negative numbers
 * - netAmountInCollectiveCurrency * hostCurrencyFxRate = amountInHostCurrency
 *   Therefore, amountInHostCurrency / hostCurrencyFxRate= netAmountInCollectiveCurrency
 */
export function netAmount(tr) {
  const fees = tr.hostFeeInHostCurrency + tr.platformFeeInHostCurrency + tr.paymentProcessorFeeInHostCurrency || 0;
  return Math.round((tr.amountInHostCurrency + fees) / tr.hostCurrencyFxRate);
}

/**
 * Verify net amount of a transaction
 */
export function verify(tr) {
  if (tr.type === 'CREDIT' && tr.amount <= 0) {
    return 'amount <= 0';
  }
  if (tr.type === 'DEBIT' && tr.amount >= 0) {
    return 'amount >= 0';
  }
  if (tr.type === 'CREDIT' && tr.netAmountInCollectiveCurrency <= 0) {
    return 'netAmount <= 0';
  }
  if (tr.type === 'DEBIT' && tr.netAmountInCollectiveCurrency >= 0) {
    return 'netAmount >= 0';
  }
  const diff = Math.abs(netAmount(tr) - tr.netAmountInCollectiveCurrency);
  // if the difference is within one cent, it's most likely a rounding error (because of the number of decimals in the hostCurrencyFxRate)
  if (diff > 0 && diff < 10) {
    return 'netAmount diff';
  }
  return true;
}

/** Calculate how off a transaction is
 *
 * Which is pretty much the difference between transaction net amount
 * & netAmountInCollectiveCurrency */
export function difference(tr) {
  return netAmount(tr) - tr.netAmountInCollectiveCurrency;
}

/** Returnt he sum of transaction rows that match search.
 *
 * @param {Object} where is an object that contains all the fields
 *  that you want to use to narrow down the search against the
 *  transactions table. For example, if you want to sum up the
 *  donations of a user to a specific collective, use the following:
 * @example
 *  > const babel = await models.Collectives.findOne({ slug: 'babel' });
 *  > libransactions.sum({ FromCollectiveId: userCollective.id, CollectiveId: babel.id })
 * @return the sum of the column `amount`.
 */
export async function sum(where) {
  const totalAttr = sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('netAmountInCollectiveCurrency')), 0);
  const attributes = [[totalAttr, 'total']];
  const result = await models.Transaction.findOne({ attributes, where });
  return result.dataValues.total;
}

const kindStrings = {
  ADDED_FUNDS: `Added Funds`,
  BALANCE_TRANSFER: `Balance Transfer`,
  CONTRIBUTION: `Contribution`,
  EXPENSE: `Expense`,
  HOST_FEE: `Host Fee`,
  HOST_FEE_SHARE: `Host Fee Share`,
  HOST_FEE_SHARE_DEBT: `Host Fee Share Debt`,
  PAYMENT_PROCESSOR_COVER: `Cover of Payment Processor Fee`,
  PLATFORM_TIP: `Platform Tip`,
  PLATFORM_TIP_DEBT: `Platform Tip Debt`,
  PREPAID_PAYMENT_METHOD: `Prepaid Payment Method`,
};

export async function generateDescription(transaction, { req = null, full = false } = {}) {
  let baseString = 'Transaction',
    debtString = '',
    tierString = '',
    extraString = '',
    fromString = '',
    toString = '';

  if (transaction.isRefund && transaction.RefundTransactionId) {
    const refundedTransaction = await (req
      ? req.loaders.Transaction.byId.load(transaction.RefundTransactionId)
      : models.Transaction.findByPk(order.RefundTransactionId));
    if (refundedTransaction) {
      const refundedTransactionDescription = await generateDescription(refundedTransaction, { req, full });
      return `Refund of "${refundedTransactionDescription}"`;
    }
  }

  let order, expense, subscription, tier;

  if (transaction.OrderId) {
    order = await (req ? req.loaders.Order.byId.load(transaction.OrderId) : models.Order.findByPk(transaction.OrderId));
  }

  if (kindStrings[transaction.kind]) {
    baseString = kindStrings[transaction.kind];
  }

  if (transaction.kind === CONTRIBUTION) {
    if (order?.TierId) {
      tier = await (req ? req.loaders.Tier.byId.load(order.TierId) : models.Tier.findByPk(order.TierId));
    }
    if (tier) {
      tierString = ` (${truncate(tier.name, { length: 128 })})`;
    }
    if (order?.SubscriptionId) {
      subscription = await (req
        ? req.loaders.Subscription.byId.load(order.SubscriptionId)
        : models.Subscription.findByPk(order.SubscriptionId));
    }
    if (subscription?.interval === 'month') {
      baseString = `Monthly contribution`;
    } else if (subscription?.interval === 'year') {
      baseString = `Yearly contribution`;
    } else if (tier && tier.type === TICKET) {
      baseString = `Registration`;
    }
  } else if (transaction.kind === ADDED_FUNDS) {
    if (order?.description && !order?.description.includes('Financial contribution to')) {
      extraString = ` - ${order.description}`;
    } else if (transaction.description && !transaction.description.includes('Financial contribution to')) {
      extraString = ` - ${transaction.description}`;
    }
  } else if (transaction.kind === EXPENSE) {
    if (transaction.ExpenseId) {
      expense = await (req
        ? req.loaders.Expense.byId.load(transaction.ExpenseId)
        : models.Expense.findByPk(transaction.ExpenseId));
    }
    if (expense) {
      if (expense.type === CHARGE) {
        baseString = 'Virtual Card charge';
      }
      if (expense.type !== CHARGE) {
        extraString = ` - ${expense.description}`;
      }
    }
  }

  const account = await (req
    ? req.loaders.Collective.byId.load(transaction.CollectiveId)
    : models.Collective.findByPk(order.CollectiveId));
  const oppositeAccount = await (req
    ? req.loaders.Collective.byId.load(transaction.FromCollectiveId)
    : models.Collective.findByPk(order.FromCollectiveId));

  if (transaction.isDebt) {
    debtString = ' owed';
    if (transaction.type === CREDIT) {
      if (full) {
        toString = ` by ${account.name.trim()}`;
      }
      fromString = ` to ${oppositeAccount.name.trim()}`;
    } else {
      fromString = ` by ${oppositeAccount.name.trim()}`;
      if (full) {
        toString = ` to ${account.name.trim()}`;
      }
    }
  } else if (transaction.kind === EXPENSE) {
    if (transaction.type === CREDIT) {
      if (full) {
        fromString = ` from ${account.name.trim()}`;
      }
      toString = ` to ${oppositeAccount.name.trim()}`;
    } else {
      fromString = ` from ${oppositeAccount.name.trim()}`;
      if (full) {
        toString = ` to ${account.name.trim()}`;
      }
    }
  } else {
    if (transaction.type === CREDIT) {
      fromString = ` from ${oppositeAccount.name.trim()}`;
      if (full) {
        toString = ` to ${account.name.trim()}`;
      }
    } else {
      if (full) {
        fromString = ` from ${account.name.trim()}`;
      }
      toString = ` to ${oppositeAccount.name.trim()}`;
    }
  }

  return `${baseString}${debtString}${fromString}${toString}${tierString}${extraString}`;
}
