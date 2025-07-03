'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "expenses__data__payment_intent_id"
      ON "Expenses" USING HASH ((data#>>'{paymentIntent,id}'))
      WHERE data#>>'{paymentIntent,id}' IS NOT NULL and "deletedAt" IS NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "expenses__data__payment_intent_id"
    `);
  },
};
