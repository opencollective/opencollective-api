'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('Transactions', ['CollectiveId', 'createdAt', 'type']);
    await queryInterface.addIndex('Subscriptions', ['isActive']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Transactions', ['CollectiveId', 'createdAt', 'type']);
    await queryInterface.removeIndex('Subscriptions', ['isActive']);
  },
};
