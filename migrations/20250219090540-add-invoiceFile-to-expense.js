'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Expenses', 'InvoiceFileId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'UploadedFiles',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });

    await queryInterface.addColumn('ExpenseHistories', 'InvoiceFileId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('ExpenseHistories', 'InvoiceFileId');
    await queryInterface.removeColumn('Expenses', 'InvoiceFileId');
  },
};
