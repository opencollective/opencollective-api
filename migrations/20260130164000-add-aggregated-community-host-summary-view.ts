'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
     CREATE OR REPLACE VIEW "CommunityHostTransactionsAggregated"
       ("FromCollectiveId", "HostCollectiveId", "hostCurrency", "year", "expenseTotal", "expenseCount", "contributionTotal", "contributionCount", "expenseTotalAcc", "expenseCountAcc", "contributionTotalAcc", "contributionCountAcc") AS
     SELECT
       "FromCollectiveId", "HostCollectiveId", "hostCurrency", ARRAY_AGG(year) AS "years"
       , ARRAY_AGG("expenseTotal") AS "expenseTotal", ARRAY_AGG("expenseCount") AS "expenseCount"
       , ARRAY_AGG("contributionTotal") AS "contributionTotal", ARRAY_AGG("contributionCount") AS "contributionCount"
       , ARRAY_AGG("expenseTotalAcc") AS "expenseTotalAcc"
       , ARRAY_AGG("expenseCountAcc") AS "expenseCountAcc", ARRAY_AGG("contributionTotalAcc") AS "contributionTotalAcc"
       , ARRAY_AGG("contributionCountAcc") AS "contributionCountAcc"
     FROM "CommunityHostTransactionSummary" cht
     GROUP BY
       "FromCollectiveId", "HostCollectiveId", "hostCurrency";
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CommunityHostTransactionsAggregated";`);
  },
};
