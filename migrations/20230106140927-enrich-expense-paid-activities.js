'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "TransactionId" = ("data" #>> '{transaction, id}')::integer
      WHERE "type" = 'collective.expense.paid'
      AND "TransactionId" IS NULL
      AND "data" #>> '{transaction, id}' IS NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "TransactionId" = NULL
      WHERE "type" = 'collective.expense.paid'
      AND "TransactionId" IS NOT NULL
      AND "data" #>> '{transaction, id}' IS NOT NULL
    `);
  },
};
