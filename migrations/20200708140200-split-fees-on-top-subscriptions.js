'use strict';

import { defaultsDeep, omit } from 'lodash';

import models from '../server/models';
import { FEES_ON_TOP_TRANSACTION_PROPERTIES } from '../server/constants/transactions';
import { getFxRate } from '../server/lib/currency';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Since all subscriptions are done in Stripe and the bug only affected Subscriptions (status = ACTIVE),
    // it is safe to group transactions by stripe charge id and verify which group has only 2 transactions instead of 4.
    // 2 transactions meaning that we have a credit/debit pair between donnor and collective and it's lacking the
    // credit/debit pair between donnor and platform.
    const [credits] = await queryInterface.sequelize.query(`
      WITH
        "feesOnTopSubscriptionOrders" AS (SELECT * FROM "Orders" o WHERE o.status = 'ACTIVE' AND o."data"->>'platformFee' IS NOT NULL),
        "feesOnTopTransactions" AS (SELECT t."data"->'charge'->'id' AS tid, count(id) FROM "Transactions" t WHERE "OrderId" IN (SELECT id FROM "feesOnTopSubscriptionOrders") GROUP BY t."data"->'charge'->'id'),
        "transactionsNeedToSplit" AS (SELECT * FROM "feesOnTopTransactions" WHERE count = 2)

      SELECT * FROM "Transactions" t WHERE t."data"->'charge'->'id' IN (SELECT tid FROM "transactionsNeedToSplit") AND t."type" = 'CREDIT';
    `);
    console.info(`Found ${credits.length} transactions that we need to split.`);

    for (const credit of credits) {
      console.info(`    -> Splitting transactions ${credit.TransactionGroup}`);
      const [[debit]] = await queryInterface.sequelize.query(`
          SELECT * FROM "Transactions" WHERE "OrderId" = ${credit.OrderId} AND "TransactionGroup" = '${credit.TransactionGroup}' AND type = 'DEBIT';
        `);
      if (!debit) {
        console.warn(`    /!\\ Couldn't find the debit transaction, skipping...`);
      }

      const platformCurrencyFxRate = await getFxRate(
        credit.currency,
        FEES_ON_TOP_TRANSACTION_PROPERTIES.currency,
        credit.createdAt,
      );
      const donationTransaction = defaultsDeep(
        {},
        FEES_ON_TOP_TRANSACTION_PROPERTIES,
        {
          description: 'Financial contribution to Open Collective',
          amount: Math.round(Math.abs(credit.platformFeeInHostCurrency) * platformCurrencyFxRate),
          amountInHostCurrency: Math.round(Math.abs(credit.platformFeeInHostCurrency) * platformCurrencyFxRate),
          platformFeeInHostCurrency: 0,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          netAmountInCollectiveCurrency: Math.round(
            Math.abs(credit.platformFeeInHostCurrency) * platformCurrencyFxRate,
          ),
          hostCurrencyFxRate: platformCurrencyFxRate,
          data: {
            hostToPlatformFxRate: await getFxRate(credit.hostCurrency, FEES_ON_TOP_TRANSACTION_PROPERTIES.currency),
            isFeesOnTop: true,
          },
        },
        omit(credit, ['id', 'uuid']),
      );

      await models.Transaction.createDoubleEntry(donationTransaction);

      // Remove fees from main transactions
      await models.Transaction.update(
        {
          amountInHostCurrency: credit.amountInHostCurrency + credit.platformFeeInHostCurrency,
          amount: credit.amount + credit.platformFeeInHostCurrency / (credit.hostCurrencyFxRate || 1),
          platformFeeInHostCurrency: 0,
          data: {
            ...credit.data,
            isFeesOnTop: true,
          },
        },
        { where: { id: credit.id } },
      );
      await models.Transaction.update(
        {
          netAmountInCollectiveCurrency:
            debit.netAmountInCollectiveCurrency - debit.platformFeeInHostCurrency / debit.hostCurrencyFxRate,
          platformFeeInHostCurrency: 0,
          data: {
            ...debit.data,
            isFeesOnTop: true,
          },
        },
        { where: { id: debit.id } },
      );
    }
  },

  down: async () => {},
};
