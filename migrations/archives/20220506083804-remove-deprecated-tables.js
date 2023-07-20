'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.dropTable('Sessions');
    await queryInterface.dropTable('LedgerTransactions');
    await queryInterface.dropTable('Wallets');
  },

  async down() {
    // No rollback
  },
};
