'use strict';

import { defaultsDeep, omit } from 'lodash';

import roles from '../server/constants/roles';
import { getFxRate } from '../server/lib/currency';
import models from '../server/models';

module.exports = {
  up: async queryInterface => {
    const platform = await models.Collective.findByPk(8686);

    const [orders] = await queryInterface.sequelize.query(`
      SELECT * FROM "Orders"
      WHERE status = 'PAID'
      AND data->>'platformFee' IS NOT NULL
      AND data->>'isFeesOnTop' IS NULL;
    `);
    console.info(`Found ${orders.lenght} orders that require migration`);
    for (const order of orders) {
      console.info(`  -> Splitting transactions for order ${order.id}`);
      const [credits] = await queryInterface.sequelize.query(`
        SELECT * FROM "Transactions" WHERE "OrderId" = ${order.id} AND type = 'CREDIT';
      `);

      for (const credit of credits) {
        console.info(`    -> Splitting transactions ${credit.TransactionGroup}`);
        const [[debit]] = await queryInterface.sequelize.query(`
          SELECT * FROM "Transactions" WHERE "OrderId" = ${order.id} AND "TransactionGroup" = '${credit.TransactionGroup}' AND type = 'DEBIT';
        `);
        if (!debit) {
          console.warn(`    /!\\ Couldn't find the debit transaction, skipping...`);
        }

        const platformCurrencyFxRate = await getFxRate(credit.currency, 'USD', credit.createdAt);
        const donationTransaction = defaultsDeep(
          {},
          {
            kind: TransactionKind.PLATFORM_TIP,
            CollectiveId: 8686,
            HostCollectiveId: 8686,
            hostCurrency: 'USD',
            currency: 'USD',
          },
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
              hostToPlatformFxRate: await getFxRate(credit.hostCurrency, 'USD'),
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
        // Add user as backer
        await platform.findOrAddUserWithRole(
          { id: order.CreatedByUserId, CollectiveId: order.FromCollectiveId },
          roles.BACKER,
          {},
          { order },
        );
      }
    }

    await queryInterface.sequelize.query(`
      UPDATE "Orders"
      SET data = jsonb_set(data, '{isFeesOnTop}', 'true')
      WHERE data->>'platformFee' IS NOT NULL
      AND data->>'isFeesOnTop' IS NULL;
    `);
  },

  down: async () => {
    // No rollback
  },
};
