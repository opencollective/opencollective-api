'use strict';

import type { DataTypes, QueryInterface } from 'sequelize';

module.exports = {
  async up(queryInterface: QueryInterface, Sequelize: typeof DataTypes) {
    await queryInterface.createTable('ExportRequests', {
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
      CreatedByUserId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Users' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      type: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      parameters: {
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: {},
      },
      status: {
        type: Sequelize.ENUM('ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'),
        allowNull: false,
        defaultValue: 'ENQUEUED',
      },
      data: {
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: {},
      },
      expiresAt: {
        type: Sequelize.DATE,
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

    await queryInterface.addIndex('ExportRequests', ['CollectiveId']);
    await queryInterface.addIndex('ExportRequests', ['CreatedByUserId']);
    await queryInterface.addIndex('ExportRequests', ['status']);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.dropTable('ExportRequests');
  },
};
