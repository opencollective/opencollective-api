'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('Transactions', ['CollectiveId', 'createdAt', 'type'], { concurrently: true });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Transactions', ['CollectiveId', 'createdAt', 'type']);
  },
};
