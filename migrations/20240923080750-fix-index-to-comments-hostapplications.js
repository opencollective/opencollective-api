'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.removeIndex('Comments', ['HostApplicationId']);
    await queryInterface.addIndex('Comments', ['HostApplicationId', 'createdAt'], {
      concurrently: true,
      where: {
        HostApplicationId: { [Sequelize.Op.ne]: null },
      },
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('Comments', ['HostApplicationId', 'createdAt']);
    await queryInterface.addIndex('Comments', ['HostApplicationId'], {
      concurrently: true,
      where: {
        HostApplicationId: { [Sequelize.Op.ne]: null },
      },
    });
  },
};
