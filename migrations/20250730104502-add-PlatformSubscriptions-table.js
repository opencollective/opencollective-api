'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      CREATE EXTENSION IF NOT EXISTS btree_gist;
    `);

    await queryInterface.createTable('PlatformSubscriptions', {
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
      plan: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: Sequelize.literal(`'{}'`),
      },
      period: {
        type: Sequelize.RANGE(Sequelize.DATE),
        allowNull: false,
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

    await queryInterface.createTable('PlatformSubscriptionHistories', {
      id: {
        type: Sequelize.INTEGER,
      },
      CollectiveId: {
        type: Sequelize.INTEGER,
      },
      plan: {
        type: Sequelize.JSONB,
      },
      period: {
        type: Sequelize.RANGE(Sequelize.DATE),
      },
      createdAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
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

    await queryInterface.sequelize.query(`
      ALTER TABLE "PlatformSubscriptions"
      ADD CONSTRAINT "PlatformSubscriptions_unique_period_per_CollectiveId"
      EXCLUDE USING GIST ("CollectiveId" WITH =, period WITH &&)
      WHERE ("deletedAt" IS NULL);  
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('PlatformSubscriptionHistories');
    await queryInterface.dropTable('PlatformSubscriptions');
    await queryInterface.sequelize.query(`
      DROP EXTENSION IF EXISTS btree_gist;
    `);
  },
};
