'use strict';

import type { DataTypes, QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface, Sequelize: typeof DataTypes) {
    await queryInterface.addColumn('Expenses', 'approvedByCollectiveId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });
    await queryInterface.addColumn('Expenses', 'paidByCollectiveId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });

    await queryInterface.addColumn('ExpenseHistories', 'approvedByCollectiveId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('ExpenseHistories', 'paidByCollectiveId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.removeColumn('Expenses', 'approvedByCollectiveId');
    await queryInterface.removeColumn('Expenses', 'paidByCollectiveId');
    await queryInterface.removeColumn('ExpenseHistories', 'approvedByCollectiveId');
    await queryInterface.removeColumn('ExpenseHistories', 'paidByCollectiveId');
  },
};
