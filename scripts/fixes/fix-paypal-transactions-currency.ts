#!/usr/bin/env ./node_modules/.bin/ts-node
import '../../server/env.js';

import { get, groupBy } from 'lodash-es';

import { getFxRate } from '../../server/lib/currency.js';
import { paypalAmountToCents } from '../../server/lib/paypal.js';
import models, { sequelize } from '../../server/models/index.js';

const migrate = async () => {
  // Update credits, should update transactions:
  const transactions = await sequelize.query(
    `
    SELECT
      t.*
    FROM
      "Transactions" t 
    WHERE
      t.kind = 'CONTRIBUTION'
      AND t."data" -> 'capture' -> 'amount' ->> 'currency_code' IS NOT NULL 
      AND t."data" -> 'capture' -> 'amount' ->> 'currency_code' != t.currency 
  `,
    {
      type: sequelize.QueryTypes.SELECT,
      model: models.Transaction,
      mapToModel: true,
    },
  );

  // Group transactions by order, to treat DEBIT and CREDIT at the same time
  const groupedTransactions = Object.values(groupBy(transactions, 'OrderId'));
  console.log(`Updating ${groupedTransactions.length} transactions pairs`);

  for (const transactions of groupedTransactions) {
    const credit = transactions.find(t => t.type === 'CREDIT');
    const debit = transactions.find(t => t.type === 'DEBIT');

    // Extract PayPal data
    const amount = paypalAmountToCents(credit.data.capture.amount.value);
    const rawPaypalFee = get(credit.data.capture, 'seller_receivable_breakdown.paypal_fee.value', '0.0');
    const paypalFee = paypalAmountToCents(rawPaypalFee);
    const currency = credit.data.capture.amount.currency_code;

    // Compute amounts
    const hostCurrencyFxRate = await getFxRate(currency, credit.hostCurrency, credit.createdAt);
    const amountInHostCurrency = Math.round(hostCurrencyFxRate * amount);
    const hostFeePercent = Math.abs(credit.hostFeeInHostCurrency) / credit.amountInHostCurrency;
    const hostFeeInHostCurrency = -Math.round(amountInHostCurrency * hostFeePercent);
    const paymentProcessorFeeInHostCurrency = -Math.round(hostCurrencyFxRate * paypalFee);
    const transactionFees = hostFeeInHostCurrency + paymentProcessorFeeInHostCurrency;
    const netAmountInCollectiveCurrency = Math.round((amountInHostCurrency + transactionFees) / hostCurrencyFxRate);

    // Update credit transaction
    const creditData = {
      currency,
      amount,
      hostFeeInHostCurrency,
      paymentProcessorFeeInHostCurrency,
      hostCurrencyFxRate,
      amountInHostCurrency,
      netAmountInCollectiveCurrency,
    };

    const debitData = {
      currency,
      amount: -netAmountInCollectiveCurrency,
      hostFeeInHostCurrency,
      paymentProcessorFeeInHostCurrency,
      hostCurrencyFxRate,
      amountInHostCurrency: -Math.round(netAmountInCollectiveCurrency * hostCurrencyFxRate),
      netAmountInCollectiveCurrency: -amount,
    };

    if (process.env.DRY) {
      console.log(`Would update CREDIT #${credit.id} with ${JSON.stringify(creditData)}`);
      console.log(`Would update DEBIT #${debit.id} with ${JSON.stringify(debitData)}`);
    } else {
      await credit.update(creditData);
      await debit.update(debitData);
    }
  }
};

const main = async () => {
  return migrate();
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
