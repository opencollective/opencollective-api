'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      create index concurrently "Transactions_HostCollectiveId_CollectiveId" on "Transactions"("HostCollectiveId","createdAt") include ("CollectiveId") where "deletedAt" IS null;  
    `);

    await queryInterface.sequelize.query(
      `create index concurrently "Activities_ExpensePaid_HostCollectiveId_ExpenseId" on "Activities"("HostCollectiveId","createdAt") include ("ExpenseId") where "type" = 'collective.expense.paid';`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX "Transactions_HostCollectiveId_CollectiveId";  
    `);

    await queryInterface.sequelize.query(`DROP INDEX "Activities_ExpensePaid_HostCollectiveId_ExpenseId";`);
  },
};
