'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Create table
    await queryInterface.createTable('AccountingCategories', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      code: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      friendlyName: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      CollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    // Add a unique index on Host <> code
    await queryInterface.addIndex('AccountingCategories', ['CollectiveId', 'code'], {
      unique: true,
      fields: ['CollectiveId', 'code'],
    });

    // Reference accounting category from the `Expenses` table
    await queryInterface.addColumn('ExpenseHistories', 'AccountingCategoryId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('Expenses', 'AccountingCategoryId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'AccountingCategories' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Expenses', 'AccountingCategoryId');
    await queryInterface.removeColumn('ExpenseHistories', 'AccountingCategoryId');
    await queryInterface.dropTable('AccountingCategories');
  },
};
