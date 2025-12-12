'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('Expenses', ['InvoiceFileId'], {
      where: { deletedAt: null },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Expenses', ['InvoiceFileId']);
  },
};
