'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_Expenses_type" ADD VALUE 'SETTLEMENT';`);
    await queryInterface.sequelize.query(`ALTER TYPE "enum_ExpenseHistories_type" ADD VALUE 'SETTLEMENT';`);
    await queryInterface.sequelize.query(
      `UPDATE "Expenses" SET "type" = 'SETTLEMENT' WHERE ("data"->>'isPlatformTipSettlement')::bool IS TRUE;`,
    );
  },

  down: async () => {
    // Can't undo this without loosing data
  },
};
