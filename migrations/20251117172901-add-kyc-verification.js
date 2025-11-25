'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('KYCVerifications', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      CollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        allowNull: false,
      },
      RequestedByCollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        allowNull: false,
      },
      data: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: Sequelize.literal(`'{}'`),
      },
      provider: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      status: {
        type: Sequelize.TEXT,
        defaultValue: 'PENDING',
        allowNull: false,
      },
      revokedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      verifiedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
        allowNull: false,
      },
      deletedAt: {
        type: Sequelize.DATE,
      },
    });

    await queryInterface.addIndex('KYCVerifications', ['CollectiveId']);
    await queryInterface.addIndex('KYCVerifications', ['RequestedByCollectiveId']);
    await queryInterface.addIndex('KYCVerifications', ['CollectiveId', 'RequestedByCollectiveId']);

    await queryInterface.createTable('KYCVerificationHistories', {
      id: {
        type: Sequelize.INTEGER,
      },
      CollectiveId: {
        type: Sequelize.INTEGER,
      },
      RequestedByCollectiveId: {
        type: Sequelize.INTEGER,
      },
      data: {
        type: Sequelize.JSONB,
      },
      provider: {
        type: Sequelize.TEXT,
      },
      status: {
        type: Sequelize.TEXT,
      },
      revokedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      verifiedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      deletedAt: {
        type: Sequelize.DATE,
      },
      hid: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        unique: true,
      },
      archivedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('KYCVerificationHistories');
    await queryInterface.dropTable('KYCVerifications');
  },
};
