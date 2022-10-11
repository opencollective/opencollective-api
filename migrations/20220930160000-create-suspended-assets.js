'use strict';

import { AssetType } from '../server/models/SuspendedAsset';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('SuspendedAssets', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      type: {
        type: Sequelize.ENUM(...Object.values(AssetType)),
        allowNull: false,
      },
      reason: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      fingerprint: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      createdAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
      deletedAt: {
        type: Sequelize.DATE,
      },
    });

    await queryInterface.addIndex('SuspendedAssets', ['type', 'fingerprint'], {
      unique: true,
      where: { deletedAt: null },
    });
  },

  down: queryInterface => {
    return queryInterface.dropTable('SuspendedAssets');
  },
};
