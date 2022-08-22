'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('MigrationLogs', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      type: {
        type: Sequelize.ENUM('MIGRATION', 'MANUAL', 'MERGE_ACCOUNTS'),
        allowNull: false,
      },
      description: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      createdAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
        allowNull: false,
      },
      data: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: '{}',
      },
      CreatedByUserId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Users' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
    });
  },

  down: async queryInterface => {
    await queryInterface.dropTable('MigrationLogs');
  },
};
