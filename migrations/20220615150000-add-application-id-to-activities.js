'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Activities', 'ApplicationId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Applications' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Activities', 'ApplicationId');
  },
};
