'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities" SET "type" = 'order.pending' WHERE "type" = 'order.processing';
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Activities" SET "type" = 'order.pending.crypto' WHERE "type" = 'order.processing.crypto';
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities" SET "type" = 'order.processing' WHERE "type" = 'order.pending';
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Activities" SET "type" = 'order.processing.crypto' WHERE "type" = 'order.pending.crypto';
    `);
  },
};
