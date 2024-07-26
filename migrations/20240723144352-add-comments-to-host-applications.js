'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Comments', 'HostApplicationId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        key: 'id',
        model: 'HostApplications',
      },
    });

    await queryInterface.addColumn('CommentHistories', 'HostApplicationId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Comments', 'HostApplicationId');
    await queryInterface.removeColumn('CommentHistories', 'HostApplicationId');
  },
};
