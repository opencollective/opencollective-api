'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('LegalDocuments', ['CollectiveId'], { concurrently: true });
    await queryInterface.addIndex('Expenses', ['status'], { concurrently: true });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('LegalDocuments', ['CollectiveId']);
    await queryInterface.removeIndex('Expenses', ['status']);
  },
};
