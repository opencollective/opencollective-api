'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_Expenses_type" ADD VALUE 'FUNDING_REQUEST' AFTER 'INVOICE';`,
    );
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_ExpenseHistories_type" ADD VALUE 'FUNDING_REQUEST' AFTER 'INVOICE';`,
    );
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(`DELETE FROM pg_enum WHERE enumlabel = 'FUNDING_REQUEST' AND enumtypid = (
      SELECT oid FROM pg_type WHERE typname = 'enum_Expenses_type'
     );`);
    await queryInterface.sequelize.query(`DELETE FROM pg_enum WHERE enumlabel = 'FUNDING_REQUEST' AND enumtypid = (
      SELECT oid FROM pg_type WHERE typname = 'enum_ExpenseHistories_type'
     );`);
  },
};
