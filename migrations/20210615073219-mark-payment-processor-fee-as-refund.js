'use strict';

/**
 * For now we only use PAYMENT_PROCESSOR_FEE to track refunded fees, so it's safe
 * to have a loose filter solely on kind.
 */
module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "isRefund" = TRUE
      WHERE kind = 'PAYMENT_PROCESSOR_FEE'
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "isRefund" = FALSE
      WHERE kind = 'PAYMENT_PROCESSOR_FEE'
    `);
  },
};
