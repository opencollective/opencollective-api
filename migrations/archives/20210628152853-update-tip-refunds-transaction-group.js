'use strict';

module.exports = {
  up: async queryInterface => {
    return queryInterface.sequelize.query(`
      UPDATE
        "Transactions" tip
      SET
        "TransactionGroup" = t."TransactionGroup",
        "data" = JSONB_SET(tip."data", '{transactionGroupBeforeTipRefundMigration}', CONCAT('"', tip."TransactionGroup"::text, '"')::jsonb, TRUE)
      FROM
        "Transactions" t
      WHERE tip."OrderId" = t."OrderId"
      AND t."type" = tip."type" 
      AND ABS(EXTRACT(EPOCH FROM (tip."createdAt" - t."createdAt"))) < 2 -- Less than 2 seconds difference in createdAt
      AND tip."TransactionGroup" != t."TransactionGroup" 
      AND tip."kind" = 'PLATFORM_TIP'
      AND tip."isRefund" IS TRUE
      AND t."OrderId" IS NOT NULL
      AND t."kind" IN ('CONTRIBUTION', 'ADDED_FUNDS') 
      AND t."isRefund" IS TRUE
    `);
  },

  down: async () => {
    // Empty
  },
};
