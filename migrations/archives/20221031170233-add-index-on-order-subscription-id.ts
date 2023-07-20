'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addIndex('Orders', ['SubscriptionId'], {
      concurrently: true,
      where: { deletedAt: null, SubscriptionId: { [Sequelize.Op.ne]: null } },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Orders', ['SubscriptionId']);
  },
};
