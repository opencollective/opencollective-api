'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    await queryInterface.addColumn('VirtualCards', 'UserId', {
      type: DataTypes.INTEGER,
      references: { model: 'Users', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: true,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('VirtualCards', 'UserId');
  },
};
