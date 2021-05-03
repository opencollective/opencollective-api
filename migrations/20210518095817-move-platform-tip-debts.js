'use strict';

import models from '../server/models';

/**
 * This migration aims to migrate the existing platform tips created this month (and thus not invoiced yet)
 * to the new debt/settlement system.
 */
module.exports = {
  up: async queryInterface => {
    const [tipCreditTransactions] = await queryInterface.sequelize.query(`
      SELECT *
      FROM "Transactions" t
      WHERE t.kind = 'PLATFORM_TIP'
      AND t.type = 'CREDIT'
      AND t."createdAt" >= '2021-05-01'
    `);

    const results = await Promise.all(
      tipCreditTransactions.map(transaction => {
        return models.Transaction.createPlatformTipDebtTransactions(transaction);
      }),
    );

    console.info(`${results.length} platform tips migrated`);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DELETE FROM "Transactions"
      WHERE "isDebt" = TRUE
      AND "TransactionGroup" IN (
        SELECT "TransactionGroup"
        FROM "Transactions" t
        WHERE t.kind = 'PLATFORM_TIP'
        AND t.type = 'CREDIT'
        AND t."createdAt" >= '2021-05-01'
      )
    `);

    await queryInterface.sequelize.query(`
      DELETE FROM "TransactionSettlements"
      WHERE "kind" = 'PLATFORM_TIP'
      AND "TransactionGroup" IN (
        SELECT "TransactionGroup"
        FROM "Transactions" t
        WHERE t.kind = 'PLATFORM_TIP'
        AND t.type = 'CREDIT'
        AND t."createdAt" >= '2021-05-01'
      )
    `);
  },
};
