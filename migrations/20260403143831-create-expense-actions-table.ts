'use strict';

import type { DataTypes, QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface, Sequelize: typeof DataTypes) {
    await queryInterface.createTable('ExpenseActions', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      ExpenseId: {
        type: Sequelize.INTEGER,
        references: { model: 'Expenses', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      UserId: {
        type: Sequelize.INTEGER,
        references: { model: 'Users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      action: {
        type: Sequelize.ENUM('APPROVED', 'PAID'),
        allowNull: false,
      },
      createdAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
        allowNull: false,
      },
      deletedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex('ExpenseActions', ['ExpenseId']);
    await queryInterface.addIndex('ExpenseActions', ['UserId']);
    await queryInterface.addIndex('ExpenseActions', ['action']);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.dropTable('ExpenseActions');
  },
};
