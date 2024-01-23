'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Expenses', 'PaymentMethodId', {
      type: Sequelize.INTEGER,
      references: {
        model: 'PaymentMethods',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });
    await queryInterface.addColumn('ExpenseHistories', 'PaymentMethodId', {
      type: Sequelize.INTEGER,
      references: {
        model: 'PaymentMethods',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Expenses', 'PaymentMethodId');
    await queryInterface.removeColumn('ExpenseHistories', 'PaymentMethodId');
  },
};
