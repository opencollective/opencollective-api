'use strict';

import type { DataTypes, QueryInterface } from 'sequelize';

import CustomDataTypes from '../server/models/DataTypes';

module.exports = {
  async up(queryInterface: QueryInterface, Sequelize: typeof DataTypes) {
    // Transactions imports
    await queryInterface.createTable('TransactionsImports', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      CollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      UploadedFileId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'UploadedFiles' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      source: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      type: {
        type: Sequelize.ENUM('CSV', 'MANUAL'),
        allowNull: false,
      },
      csvConfig: {
        type: Sequelize.JSONB,
        allowNull: true,
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
      deletedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex('TransactionsImports', ['CollectiveId']);

    // Transactions imports rows
    await queryInterface.createTable('TransactionsImportsRows', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      TransactionsImportId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'TransactionsImports' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      ExpenseId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Expenses' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      OrderId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Orders' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      sourceId: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      isDismissed: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      description: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: '',
      },
      date: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      amount: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      currency: CustomDataTypes(Sequelize).currency,
      rawValue: {
        type: Sequelize.JSONB,
        allowNull: true,
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
      deletedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex('TransactionsImportsRows', ['TransactionsImportId']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('TransactionsImportsRows');
    await queryInterface.dropTable('TransactionsImports');
  },
};
