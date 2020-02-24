'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Conversations', 'ExpenseId', {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'PayoutMethods' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Expenses', 'ExpenseId');
  },
};
