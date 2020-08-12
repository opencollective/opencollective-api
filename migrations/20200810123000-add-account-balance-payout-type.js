'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_PayoutMethods_type" ADD VALUE 'ACCOUNT_BALANCE' AFTER 'BANK_ACCOUNT';`,
    );
  },

  down: async (queryInterface, Sequelize) => {
    // Can't undo this without loosing data
  },
};
