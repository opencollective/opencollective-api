'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Notifications"
      SET "type" = 'order.processed'
      WHERE "type" = 'order.thankyou'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Notifications"
      SET "type" = 'order.thankyou'
      WHERE "type" = 'order.processed'
    `);
  },
};
