'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('UserTokens', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      type: {
        type: Sequelize.ENUM('OAUTH'),
        allowNull: false,
      },
      token: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      expiresAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      refreshToken: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      refreshTokenExpiresAt: {
        type: Sequelize.DATE,
        allowNull: true,
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

    await queryInterface.addIndex('UserTokens', ['token'], { unique: true });
    await queryInterface.addIndex('UserTokens', ['UserId', 'ApplicationId'], {
      unique: true,
      where: { deletedAt: null },
    });
  },

  down: queryInterface => {
    return queryInterface.dropTable('UserTokens');
  },
};
