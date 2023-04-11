'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('Expenses', ['PayoutMethodId'], {
      concurrently: true,
      where: { deletedAt: null },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Members', ['PayoutMethodId']);
  },
};
