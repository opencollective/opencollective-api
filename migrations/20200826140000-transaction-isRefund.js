'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tableDefinition = await queryInterface.describeTable('Transactions');
    if (!tableDefinition.isRefund) {
      await queryInterface.addColumn('Transactions', 'isRefund', {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      });
    }

    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "isRefund" = TRUE
      WHERE "RefundTransactionId" IS NOT null AND description like 'Refund of "%';
    `);
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Transactions', 'isRefund');
  },
};
