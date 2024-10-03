'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_TransactionsImports_type" ADD VALUE IF NOT EXISTS 'PLAID';
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_TransactionsImports_type" DROP VALUE IF EXISTS 'PLAID';
    `);
  },
};
