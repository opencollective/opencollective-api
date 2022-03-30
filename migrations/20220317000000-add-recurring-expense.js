'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('RecurringExpenses', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
        allowNull: false,
      },
      deletedAt: {
        type: Sequelize.DATE,
      },
      CollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      FromCollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      interval: {
        allowNull: false,
        type: Sequelize.STRING,
      },
      lastDraftedAt: {
        type: Sequelize.DATE,
      },
      endsAt: {
        type: Sequelize.DATE,
      },
    });

    await queryInterface.addColumn('Expenses', 'RecurringExpenseId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'RecurringExpenses' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });

    await queryInterface.addColumn('ExpenseHistories', 'RecurringExpenseId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'RecurringExpenses' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Expenses', 'RecurringExpenseId');
    await queryInterface.removeColumn('ExpenseHistories', 'RecurringExpenseId');
    await queryInterface.dropTable('RecurringExpenses');
  },
};
