'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "TransactionSettlements" ts
      SET "deletedAt" = NOW()
      FROM "Transactions" t
      WHERE ts."TransactionGroup" = t."TransactionGroup" AND ts."kind" = t."kind"
      AND t."kind" = 'HOST_FEE_SHARE' AND t."amount" = 0
    `);
    await queryInterface.sequelize.query(`
      UPDATE "Transactions" t
      SET "deletedAt" = NOW()
      WHERE t."kind" = 'HOST_FEE_SHARE' AND t."amount" = 0
    `);
  },

  down: async () => {
    // Nothing to do here
  },
};
