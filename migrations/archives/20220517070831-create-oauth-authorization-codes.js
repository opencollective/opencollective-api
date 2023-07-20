'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('OAuthAuthorizationCodes', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      code: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      redirectUri: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      expiresAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      ApplicationId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Applications' },
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

    await queryInterface.addIndex('OAuthAuthorizationCodes', ['code'], {
      unique: true,
      where: { deletedAt: null },
    });
  },

  down: queryInterface => {
    return queryInterface.dropTable('OAuthAuthorizationCodes');
  },
};
