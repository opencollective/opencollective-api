'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('ExpenseAttachedFiles', ['url']);
    await queryInterface.addIndex('ExpenseItems', ['url']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('ExpenseItems', ['url']);
    await queryInterface.removeIndex('ExpenseAttachedFiles', ['url']);
  },
};
