'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('TransactionsImportsRows', 'status', {
      type: Sequelize.ENUM('LINKED', 'IGNORED', 'ON_HOLD', 'PENDING'),
      defaultValue: 'PENDING',
      allowNull: false,
    });

    await queryInterface.sequelize.query(`
      UPDATE "TransactionsImportsRows"
      SET "status" = 'IGNORED'
      WHERE "isDismissed" = true
    `);

    await queryInterface.sequelize.query(`
      UPDATE "TransactionsImportsRows"
      SET "status" = 'LINKED'
      WHERE "ExpenseId" IS NOT NULL
      OR "OrderId" IS NOT NULL
    `);

    await queryInterface.removeColumn('TransactionsImportsRows', 'isDismissed');

    await queryInterface.addIndex('TransactionsImportsRows', ['TransactionsImportId', 'status']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('TransactionsImportsRows', 'status');
    await queryInterface.addColumn('TransactionsImportsRows', 'isDismissed', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },
};
