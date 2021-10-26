'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_Expenses_type" RENAME VALUE 'FUNDING_REQUEST' TO 'GRANT';`);
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_ExpenseHistories_type" RENAME VALUE 'FUNDING_REQUEST' TO 'GRANT';`,
    );
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_Expenses_type" RENAME VALUE 'GRANT' TO 'FUNDING_REQUEST'
     );`,
    );
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_ExpenseHistories_type" RENAME VALUE 'GRANT' TO 'FUNDING_REQUEST'
     );`,
    );
  },
};
