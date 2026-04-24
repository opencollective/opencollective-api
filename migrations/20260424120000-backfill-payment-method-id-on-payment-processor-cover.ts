'use strict';

import type { QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions" AS ppc
      SET "PaymentMethodId" = contrib."PaymentMethodId"
      FROM "Transactions" AS contrib
      WHERE ppc.kind = 'PAYMENT_PROCESSOR_COVER'
        AND ppc."deletedAt" IS NULL
        AND ppc."PaymentMethodId" IS NULL
        AND contrib."TransactionGroup" = ppc."TransactionGroup"
        AND contrib.kind = 'CONTRIBUTION'
        AND contrib.type = 'CREDIT'
        AND contrib."PaymentMethodId" IS NOT NULL
        AND contrib."deletedAt" IS NULL
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions" AS ppc
      SET "PaymentMethodId" = NULL
      WHERE kind = 'PAYMENT_PROCESSOR_COVER'
      AND "deletedAt" IS NULL
    `);
  },
};
