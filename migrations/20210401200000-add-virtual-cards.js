'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    await queryInterface.createTable('VirtualCards', {
      id: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
      },
      CollectiveId: {
        type: DataTypes.INTEGER,
        references: { model: 'Collectives', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      HostCollectiveId: {
        type: DataTypes.INTEGER,
        references: { model: 'Collectives', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      last4: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      data: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      privateData: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
      deletedAt: {
        type: DataTypes.DATE,
      },
    });
  },

  down: async queryInterface => {
    await queryInterface.dropTable('VirtualCards');
  },
};
