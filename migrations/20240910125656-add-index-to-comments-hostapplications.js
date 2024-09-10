'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addIndex('Comments', ['HostApplicationId'], {
      concurrently: true,
      where: {
        HostApplicationId: { [Sequelize.Op.ne]: null },
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Comments', ['HostApplicationId']);
  },
};
