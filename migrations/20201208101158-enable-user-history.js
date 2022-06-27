'use strict';

module.exports = {
  up: (queryInterface, DataTypes) => {
    return queryInterface.createTable('UserHistories', {
      id: DataTypes.INTEGER,
      email: DataTypes.STRING,
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
      deletedAt: DataTypes.DATE,
      firstName: DataTypes.STRING,
      lastName: DataTypes.STRING,
      CollectiveId: DataTypes.INTEGER,
      newsletterOptIn: DataTypes.BOOLEAN,
      emailWaitingForValidation: DataTypes.STRING,
      emailConfirmationToken: DataTypes.STRING,
      lastLoginAt: DataTypes.DATE,
      data: DataTypes.JSON,
      twoFactorAuthToken: DataTypes.STRING,
      confirmedAt: DataTypes.DATE,
      hid: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        unique: true,
      },
      archivedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    });
  },

  down: queryInterface => {
    return queryInterface.dropTable('UserHistories');
  },
};
