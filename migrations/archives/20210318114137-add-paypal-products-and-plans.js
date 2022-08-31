'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    await queryInterface.createTable('PaypalProducts', {
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
      TierId: {
        type: DataTypes.INTEGER,
        references: { model: 'Tiers', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
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

    await queryInterface.createTable('PaypalPlans', {
      id: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
      },
      amount: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      interval: {
        type: DataTypes.ENUM('day', 'week', 'month', 'year'),
        allowNull: false,
      },
      ProductId: {
        type: DataTypes.STRING,
        references: { key: 'id', model: 'PaypalProducts' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
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

    await queryInterface.addIndex('PaypalProducts', ['CollectiveId', 'TierId']);
    await queryInterface.addIndex('PaypalPlans', ['ProductId']);
  },

  down: async queryInterface => {
    await queryInterface.dropTable('PaypalPlans');
    await queryInterface.dropTable('PaypalProducts');
  },
};
