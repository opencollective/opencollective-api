'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "data" = jsonb_set(jsonb_set("data", '{isSharedRevenue}', 'false'), '{owedHostFeeShare}', TO_JSONB("hostFeeInHostCurrency" * CAST("data"->>'hostFeeSharePercent' AS NUMERIC) / 100)) - 'settled' - 'hostFeeSharePercent'
      WHERE
      "deletedAt" IS NULL
      AND "createdAt" > '01-03-2021'
      AND "HostCollectiveId" = 11049
      AND "data"->>'isSharedRevenue' = 'true'
      AND "data"->>'settled' = 'true';
    `);
  },

  down: async () => {
    // nop
  },
};
