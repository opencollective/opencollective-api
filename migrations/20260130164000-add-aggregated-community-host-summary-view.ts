'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
    CREATE OR REPLACE VIEW "CommunityHostTransactionsAggregated"
      ("FromCollectiveId", "HostCollectiveId", "hostCurrency", "years", "expenseTotal", "expenseCount", "contributionTotal", "contributionCount", "expenseTotalAcc", "expenseCountAcc", "contributionTotalAcc", "contributionCountAcc") AS
    SELECT
      "FromCollectiveId", "HostCollectiveId", "hostCurrency"
      , ARRAY_AGG(year ORDER BY year ASC) AS "years"
      , ARRAY_AGG("expenseTotal" ORDER BY year ASC) AS "expenseTotal"
      , ARRAY_AGG("expenseCount" ORDER BY year ASC) AS "expenseCount"
      , ARRAY_AGG("contributionTotal" ORDER BY year ASC) AS "contributionTotal"
      , ARRAY_AGG("contributionCount" ORDER BY year ASC) AS "contributionCount"
      , ARRAY_AGG("expenseTotalAcc" ORDER BY year ASC) AS "expenseTotalAcc"
      , ARRAY_AGG("expenseCountAcc" ORDER BY year ASC) AS "expenseCountAcc"
      , ARRAY_AGG("contributionTotalAcc" ORDER BY year ASC) AS "contributionTotalAcc"
      , ARRAY_AGG("contributionCountAcc" ORDER BY year ASC) AS "contributionCountAcc"
    FROM "CommunityHostTransactionSummary" cht
    GROUP BY
      "FromCollectiveId", "HostCollectiveId", "hostCurrency";
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CommunityHostTransactionsAggregated";`);
  },
};
