'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Activities', 'UserTokenId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'UserTokens' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Activities', 'UserTokenId');
  },
};
