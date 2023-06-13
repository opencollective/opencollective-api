'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('Expenses', ['VirtualCardId']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Expenses', ['VirtualCardId']);
  },
};
