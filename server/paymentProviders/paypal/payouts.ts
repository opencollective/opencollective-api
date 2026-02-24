/* eslint-disable camelcase */
import { isNil, round, toNumber, truncate } from 'lodash';
import { v4 as uuid } from 'uuid';

import activities from '../../constants/activities';
import { Service } from '../../constants/connected-account';
import { SupportedCurrency } from '../../constants/currencies';
import status from '../../constants/expense-status';
import FEATURE from '../../constants/feature';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import { floatAmountToCents } from '../../lib/math';
import * as paypal from '../../lib/paypal';
import { safeJsonStringify } from '../../lib/safe-json-stringify';
import { reportErrorToSentry, reportMessageToSentry } from '../../lib/sentry';
import { createTransactionsFromPaidExpense } from '../../lib/transactions';
import models, { Collective } from '../../models';
import Expense from '../../models/Expense';
import { PayoutItemDetails } from '../../types/paypal';

const PROVIDER_NAME = Service.PAYPAL;

/**
 * As per https://developer.paypal.com/docs/api/payments.payouts-batch/v1/#payouts_post!path=items/note&t=request,
 * the note field supports "up to 4000 ASCII characters and 1000 non-ASCII characters"
 */
const getPayoutItemNote = (expense: Expense): string => {
  let result = `Expense #${expense.id}: ${truncate(expense.description, { length: 1000 })}`; // `expense.description` is a string field (max 255 chars), we only truncate it to be safe if something changes in the future.
  if (expense.reference) {
    result += ` (${truncate(expense.reference, { length: 1000 })})`;
  }

  return result;
};

export const payExpensesBatch = async (expenses: Expense[]): Promise<Expense[]> => {
  const [firstExpense] = expenses;
  const isSameHost = expenses.every(
    e =>
      !isNil(e.collective?.HostCollectiveId) &&
      e.collective.HostCollectiveId === firstExpense.collective.HostCollectiveId,
  );
  if (!isSameHost) {
    throw new Error('All expenses should have collective prop populated and belong to the same Host.');
  }

  const host = await firstExpense.collective.getHostCollective();
  if (!host) {
    throw new Error(`Could not find the host reimbursing the expense.`);
  }

  const connectedAccount = await host.getAccountForPaymentProvider(PROVIDER_NAME);

  const getExpenseItem = expense => ({
    note: getPayoutItemNote(expense),
    amount: {
      currency: expense.currency,
      value: round(expense.amount / 100, 2).toString(),
    },
    receiver: expense.PayoutMethod.data.email,
    sender_item_id: expense.id,
  });

  // Map expense items...
  const items = expenses.map(getExpenseItem);
  const sender_batch_id = uuid();

  const requestBody = {
    sender_batch_header: {
      recipient_type: 'EMAIL',
      email_message: 'Good news, your expense was paid!',
      email_subject: `Expense Payout for ${firstExpense.collective.name}`,
      sender_batch_id,
    },
    items,
  };

  try {
    const response = await paypal.executePayouts(connectedAccount, requestBody);
    const updateExpenses = expenses.map(async e => {
      await e.update({ data: { ...e.data, ...response.batch_header }, status: status.PROCESSING });
      const user = await models.User.findByPk(e.lastEditedById);
      await e.createActivity(activities.COLLECTIVE_EXPENSE_PROCESSING, user);
      return e;
    });
    return Promise.all(updateExpenses);
  } catch (error) {
    reportErrorToSentry(error, { feature: FEATURE.PAYPAL_PAYOUTS });
    const updateExpenses = expenses.map(async e => {
      await e.update({ status: status.ERROR, data: { ...e.data, error } });
      const user = await models.User.findByPk(e.lastEditedById);
      await e.createActivity(activities.COLLECTIVE_EXPENSE_ERROR, user, {
        error: { message: error.message, details: safeJsonStringify(error) },
        isSystem: true,
      });
      return e;
    });
    return Promise.all(updateExpenses);
  }
};

export const checkBatchItemStatus = async (
  item: PayoutItemDetails,
  expense: Expense,
  host: Collective,
): Promise<Expense> => {
  // Reload up-to-date values to avoid race conditions when processing batches.
  await expense.reload();
  if (expense.data.payout_batch_id !== item.payout_batch_id) {
    throw new Error(`Item does not belongs to expense it claims it does.`);
  }

  switch (item.transaction_status) {
    case 'SUCCESS':
      if (expense.status !== status.PAID) {
        const fees = {};
        let fxRate = 1 / (toNumber(item.currency_conversion?.exchange_rate) || 1);

        // When dealing with multi-currency expenses, if the host has a positive balance in the
        // requested expense currency, PayPal will use that and there will be no currency conversion.
        // But because we record the transactions in the host/collective currency, we need still need to
        // get an FX rate from somewhere. We therefore use our internal system to estimate one.
        const payoutItemCurrency = item['payout_item']?.['amount']?.['currency'];
        const isMultiCurrency = payoutItemCurrency && payoutItemCurrency !== expense.currency;
        if (isMultiCurrency && !item.currency_conversion?.exchange_rate) {
          try {
            fxRate = await getFxRate(expense.currency, host.currency);
          } catch {
            // We don't want to fail recording the transaction if we can't get an FX rate, but we'll probably
            // want to go back and update it later.
            logger.error(`Could not fetch FX rate when recording expense #${expense.id} payment`);
          }
        }

        if (item.payout_item_fee) {
          const paymentProcessorFeeInExpenseCurrency = floatAmountToCents(toNumber(item.payout_item_fee.value));
          fees['paymentProcessorFeeInHostCurrency'] = Math.round(paymentProcessorFeeInExpenseCurrency * fxRate);
          if (item.payout_item_fee.currency !== expense.currency) {
            // payout_item_fee is always supposed to be in currency_conversion.to_amount.currency. This is a sanity check just in case
            logger.error(`Payout item fee currency does not match expense #${expense.id} currency`);
            reportMessageToSentry('Payout item fee currency does not match expense currency', {
              extra: { expense: expense.info, item },
            });
          }
        }
        // This will detect that payoutMethodType=PAYPAL and set service=paypal AND type=payout
        await expense.setAndSavePaymentMethodIfMissing();
        await createTransactionsFromPaidExpense(host, expense, fees, fxRate, {
          ...item,
          clearedAt: item.time_processed && new Date(item.time_processed),
        });
        // Mark Expense as Paid, create activity and send notifications
        await expense.markAsPaid();
      }
      break;
    case 'FAILED':
    case 'BLOCKED':
    case 'REFUNDED':
    case 'RETURNED':
    case 'REVERSED':
      if (expense.status !== status.ERROR) {
        await expense.setError(expense.lastEditedById);
        await expense.createActivity(
          activities.COLLECTIVE_EXPENSE_ERROR,
          { id: expense.lastEditedById },
          { error: item.errors, isSystem: true },
        );
      }
      break;
    // Ignore cases
    case 'ONHOLD':
    case 'UNCLAIMED': // Link sent to a non-paypal user, waiting for being claimed.
    case 'PENDING':
    default:
      logger.debug(`Expense is still being processed, nothing to do but wait.`);
      break;
  }
  await expense.update({ data: item });
  return expense;
};

export const checkBatchStatus = async (batch: Expense[]): Promise<Expense[]> => {
  const [firstExpense] = batch;
  const host = await firstExpense.collective.getHostCollective();
  if (!host) {
    throw new Error(`Could not find the host reimbursing the expense.`);
  }

  const connectedAccount = await host.getAccountForPaymentProvider(PROVIDER_NAME);

  const batchId = firstExpense.data.payout_batch_id as string;
  try {
    const batchInfo = await paypal.getBatchInfo(connectedAccount, batchId);
    const checkExpense = async (expense: Expense): Promise<void> => {
      try {
        const item = batchInfo.items.find(i => i.payout_item.sender_item_id === expense.id.toString());
        if (!item) {
          throw new Error('Could not find expense in payouts batch');
        }
        await checkBatchItemStatus(item, expense, host);
      } catch (e) {
        reportErrorToSentry(e, { feature: FEATURE.PAYPAL_PAYOUTS });
      }
    };

    for (const expense of batch) {
      await checkExpense(expense);
    }
  } catch (error) {
    reportErrorToSentry(error, { feature: FEATURE.PAYPAL_PAYOUTS });
    throw new Error('There was an error fetching the batch info.');
  }
  return batch;
};

// See https://www.paypal.com/lu/business/paypal-business-fees#statement-10
const PAYPAL_PAYOUT_CAPS_BY_CURRENCY: Partial<
  Record<SupportedCurrency, { domesticMax: number; internationalMax: number }>
> = {
  AUD: { domesticMax: 16_00, internationalMax: 100_00 },
  BRL: { domesticMax: 24_00, internationalMax: 150_00 },
  CAD: { domesticMax: 14_00, internationalMax: 90_00 },
  CZK: { domesticMax: 280_00, internationalMax: 1700_00 },
  DKK: { domesticMax: 84_00, internationalMax: 500_00 },
  EUR: { domesticMax: 12_00, internationalMax: 70_00 },
  HKD: { domesticMax: 110_00, internationalMax: 660_00 },
  HUF: { domesticMax: 3080_00, internationalMax: 18_500_00 },
  ILS: { domesticMax: 50_00, internationalMax: 320_00 },
  JPY: { domesticMax: 1200, internationalMax: 8000 },
  MYR: { domesticMax: 50_00, internationalMax: 300_00 },
  MXN: { domesticMax: 170_00, internationalMax: 1080_00 },
  TWD: { domesticMax: 440_00, internationalMax: 2700_00 },
  NZD: { domesticMax: 20_00, internationalMax: 120_00 },
  NOK: { domesticMax: 90_00, internationalMax: 540_00 },
  PHP: { domesticMax: 640_00, internationalMax: 3800_00 },
  PLN: { domesticMax: 46_00, internationalMax: 280_00 },
  RUB: { domesticMax: 480_00, internationalMax: 2800_00 },
  SGD: { domesticMax: 20_00, internationalMax: 120_00 },
  SEK: { domesticMax: 100_00, internationalMax: 640_00 },
  CHF: { domesticMax: 16_00, internationalMax: 100_00 },
  THB: { domesticMax: 460_00, internationalMax: 2800_00 },
  GBP: { domesticMax: 10_00, internationalMax: 60_00 },
  USD: { domesticMax: 14_00, internationalMax: 90_00 },
};

/**
 * Tries its best to estimate PayPal payout fees for an expense. The result is an approximate amount that should **NOT**
 * be used for accounting purposes, and should be presented to the user as an estimate.
 *
 * PayPal does not provide a dedicated API endpoint for pre-calculating Payout fees, so this function implements the standard formula based on official documentation:
 * > fee = min(payout_amount * 0.02, fee_cap)
 * where fee_cap varies by currency and whether the transaction is domestic or international.
 *
 * ## Key Considerations:
 * - **No dry-run API**: Fees are only finalized post-transaction, but batch creation responses include a `fees` estimate.
 * - **Factors affecting fees**:
 *   - Sender's country (domestic vs. international caps).
 *   - Recipient currency (conversion fees may apply).
 *   - US API users: Sometimes a flat $0.25 USD per transaction.
 *
 * ## Docs:
 * - Official Payouts Fees: https://developer.paypal.com/docs/payouts/standard/reference/fees/
 * - All fees: https://www.paypal.com/lu/business/paypal-business-fees
 * - Merchant Fees (caps per currency): https://www.paypal.com/us/webapps/mpp/merchant-fees#paypal-payouts
 * - Payouts API Reference: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/
 * - Fee Calculation Details: https://www.paypal.com/us/cshelp/article/how-are-fees-for-payouts-calculated-and-reported-ts2216
 */
export const estimatePaypalPayoutFee = async (host: Collective, expense: Expense): Promise<number> => {
  const hostCountry = host.countryISO;
  const payee = expense.fromCollective || (await expense.getFromCollective());
  const hostCurrency = host.currency;
  const payeeCountry = payee.countryISO;
  const isDomestic = hostCountry === payeeCountry;
  const baseFee = Math.round(expense.amount * 0.02);
  const caps = PAYPAL_PAYOUT_CAPS_BY_CURRENCY[hostCurrency];

  // No known cap for this currency => best-effort: return 2% uncapped (can overestimate for large payouts).
  if (!caps) {
    return baseFee;
  }

  // Return the minimum of the base fee and the cap
  return Math.min(baseFee, isDomestic ? caps.domesticMax : caps.internationalMax);
};
