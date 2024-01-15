'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      UPDATE "Notifications" SET "type" = 'order.confirmed' WHERE "type" = 'order.thankyou';
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Activities" SET "type" = 'order.confirmed' WHERE "type" = 'order.thankyou';
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      UPDATE "Notifications" SET "type" = 'order.thankyou' WHERE "type" = 'order.confirmed';
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Activities" SET "type" = 'order.thankyou' WHERE "type" = 'order.confirmed';
    `);
  },
};
