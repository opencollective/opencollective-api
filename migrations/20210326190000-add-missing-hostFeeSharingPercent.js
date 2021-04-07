'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "data" = jsonb_set("data", '{hostFeeSharePercent}', '15')
      WHERE
      "deletedAt" IS NULL
      AND "hostFeeInHostCurrency" != 0
      AND "platformFeeInHostCurrency" = 0
      AND "data"->>'settled' IS NULL
      AND (
        ("HostCollectiveId" = 9802 AND "createdAt" > '2020-11-01') OR
        ("HostCollectiveId" = 9807 AND "createdAt" > '2020-12-01') OR
        ("HostCollectiveId" = 169078 AND "createdAt" > '2021-01-01')
      );
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "data" = jsonb_set("data", '{hostFeeSharePercent}', 'null')
      WHERE
      "deletedAt" IS NULL
      AND "hostFeeInHostCurrency" != 0
      AND "platformFeeInHostCurrency" = 0
      AND "data"->>'settled' IS NULL
      AND (
        ("HostCollectiveId" = 9802 AND "createdAt" > '2020-11-01') OR
        ("HostCollectiveId" = 9807 AND "createdAt" > '2020-12-01') OR
        ("HostCollectiveId" = 169078 AND "createdAt" > '2021-01-01')
      );
    `);
  },
};
