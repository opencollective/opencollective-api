'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_PayoutMethods_type" ADD VALUE 'CREDIT_CARD' AFTER 'BANK_ACCOUNT';`,
    );
    await queryInterface.sequelize.query(`ALTER TYPE "enum_Expenses_type" ADD VALUE 'CHARGE';`);
  },

  down: async () => {
    // Can't undo this without loosing data
  },
};
