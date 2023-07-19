'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('HostApplications', 'CreatedByUserId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Users' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('HostApplications', 'CreatedByUserId');
  },
};
