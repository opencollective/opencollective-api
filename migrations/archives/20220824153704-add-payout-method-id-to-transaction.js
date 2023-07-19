'use strict';

module.exports = {
  async up(queryInterface, DataTypes) {
    await queryInterface.addColumn('Transactions', 'PayoutMethodId', {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'PayoutMethods' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Transactions', 'PayoutMethodId');
  },
};
