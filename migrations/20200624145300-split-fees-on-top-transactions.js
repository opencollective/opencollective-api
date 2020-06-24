'use strict';

import { defaultsDeep, omit } from 'lodash';

import models from '../server/models';
import roles from '../server/constants/roles';
import { FEES_ON_TOP_TRANSACTION_PROPERTIES } from '../server/constants/transactions';
import { getFxRate } from '../server/lib/currency';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const platform = await models.Collective.findByPk(FEES_ON_TOP_TRANSACTION_PROPERTIES.CollectiveId);

    const [orders] = await queryInterface.sequelize.query(`
      SELECT * FROM "Orders"
      WHERE status = 'PAID'
      AND data->>'platformFee' IS NOT NULL
      AND data->>'isFeesOnTop' IS NULL;
    `);
    console.info(`Found ${orders.lenght} orders that require migration`);
    for (const order of orders) {
      console.info(`  -> Splitting transactions for order ${order.id}`);
      const [[credit, debit]] = await queryInterface.sequelize.query(`
        SELECT * FROM "Transactions" WHERE "OrderId" = ${order.id} ORDER BY type;
      `);

      const platformCurrencyFxRate = await getFxRate(
        credit.currency,
        FEES_ON_TOP_TRANSACTION_PROPERTIES.currency,
        credit.createdAt,
      );
      const donationTransaction = defaultsDeep(
        {},
        FEES_ON_TOP_TRANSACTION_PROPERTIES,
        {
          description: 'Checkout donation to Open Collective',
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
      // Add user as backer
      await platform.findOrAddUserWithRole(
        { id: order.CreatedByUserId, CollectiveId: order.FromCollectiveId },
        roles.BACKER,
        {},
        { order },
      );
    }

    await queryInterface.sequelize.query(`
      UPDATE "Orders"
      SET data = jsonb_set(data, '{isFeesOnTop}', 'true')
      WHERE data->>'platformFee' IS NOT NULL
      AND data->>'isFeesOnTop' IS NULL;
    `);
  },

  down: async () => {},
};
