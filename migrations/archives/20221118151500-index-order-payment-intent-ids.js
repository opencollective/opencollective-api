'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders__data__payment_intent_id"
      ON "Orders" USING HASH ((data#>>'{paymentIntent,id}'))
      WHERE data#>>'{paymentIntent,id}' IS NOT NULL and "deletedAt" IS NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "orders__data__payment_intent_id"
    `);
  },
};
