'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('PersonalTokens', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      token: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      expiresAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      CollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      UserId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Users' },
        allowNull: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      data: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      scope: {
        type: Sequelize.ARRAY(
          Sequelize.ENUM(
            'email',
            'incognito',
            'account',
            'expenses',
            'orders',
            'transactions',
            'virtualCards',
            'host',
            'root',
            'conversations',
            'updates',
            'webhooks',
            'applications',
            'connectedAccounts',
            'activities',
          ),
        ),
        allowNull: true,
      },

      // Standard temporal fields
      createdAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
      deletedAt: {
        type: Sequelize.DATE,
      },
    });
    await queryInterface.addIndex('PersonalTokens', ['token'], { unique: true });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('PersonalTokens');
  },
};
