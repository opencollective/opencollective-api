'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('TransactionSettlements', {
      TransactionGroup: {
        type: Sequelize.UUID,
        allowNull: false,
      },
      kind: {
        // Re-using the same ENUM than `Transactions` so that we don't have to maintain two of them
        type: '"public"."enum_Transactions_kind"',
        allowNull: false,
      },
      status: {
        type: Sequelize.ENUM('OWED', 'INVOICED', 'SETTLED'),
        allowNull: false,
      },
      ExpenseId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Expenses', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
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
    });

    // Create unique index on TransactionGroup + kind
    await queryInterface.addIndex('TransactionSettlements', ['TransactionGroup', 'kind'], {
      unique: true,
    });

    // Add `isDebt` column on `Transactions`
    await queryInterface.addColumn('Transactions', 'isDebt', { type: Sequelize.BOOLEAN, allowNull: true });
  },

  down: async queryInterface => {
    await queryInterface.dropTable('TransactionSettlements');
    await queryInterface.removeColumn('Transactions', 'isDebt');
  },
};
