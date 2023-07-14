'use strict';

import { VirtualCardRequestStatus } from '../server/models/VirtualCardRequest';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('VirtualCardRequests', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      purpose: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      notes: {
        allowNull: false,
        type: Sequelize.TEXT,
      },
      status: {
        allowNull: false,
        defaultValue: VirtualCardRequestStatus.PENDING,
        type: Sequelize.STRING,
      },
      currency: {
        allowNull: false,
        type: Sequelize.STRING,
      },
      spendingLimitAmount: {
        allowNull: false,
        type: Sequelize.INTEGER,
      },
      spendingLimitInterval: {
        allowNull: false,
        type: Sequelize.STRING,
      },
      UserId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Users' },
        allowNull: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      HostCollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        allowNull: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      CollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        allowNull: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      VirtualCardId: {
        type: Sequelize.STRING,
        references: { key: 'id', model: 'VirtualCards' },
        allowNull: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('now'),
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('now'),
      },
      deletedAt: {
        allowNull: true,
        type: Sequelize.DATE,
      },
    });

    await queryInterface.addIndex('VirtualCardRequests', ['HostCollectiveId', 'CollectiveId'], {
      where: { deletedAt: null },
    });

    await queryInterface.addColumn('VirtualCards', 'VirtualCardRequestId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'VirtualCardRequests' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('VirtualCardRequests');
    await queryInterface.removeColumn('VirtualCards', 'VirtualCardRequestId');
  },
};
