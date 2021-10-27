'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_Expenses_type" ADD VALUE 'GRANT' AFTER 'FUNDING_REQUEST';`);
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_ExpenseHistories_type" ADD VALUE 'GRANT' AFTER 'FUNDING_REQUEST';`,
    );
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`DELETE FROM pg_enum WHERE enumlabel = 'GRANT' AND enumtypid = (
      SELECT oid FROM pg_type WHERE typname = 'enum_Expenses_type'
     );`);
    await queryInterface.sequelize.query(`DELETE FROM pg_enum WHERE enumlabel = 'GRANT' AND enumtypid = (
      SELECT oid FROM pg_type WHERE typname = 'enum_ExpenseHistories_type'
     );`);
  },
};
