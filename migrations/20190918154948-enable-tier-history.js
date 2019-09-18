'use strict';

module.exports = {
  up: (queryInterface, DataTypes) => {
    return queryInterface.createTable('TierHistories', {
      id: DataTypes.INTEGER,
      CollectiveId: DataTypes.INTEGER,

      slug: DataTypes.STRING,
      name: DataTypes.STRING,
      type: DataTypes.STRING,
      description: DataTypes.STRING,
      button: DataTypes.STRING,
      amount: DataTypes.INTEGER,
      interval: DataTypes.STRING(8),
      presets: DataTypes.ARRAY(DataTypes.INTEGER),
      amountType: DataTypes.ENUM('FLEXIBLE', 'FIXED'),
      minimumAmount: DataTypes.INTEGER,
      maxQuantity: DataTypes.INTEGER,
      maxQuantityPerUser: DataTypes.INTEGER,
      startsAt: DataTypes.DATE,
      endsAt: DataTypes.DATE,
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
      deletedAt: DataTypes.DATE,

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
    return queryInterface.dropTable('TierHistories');
  },
};
