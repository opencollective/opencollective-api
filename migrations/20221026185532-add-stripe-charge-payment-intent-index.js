'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__stripe_charge_payment_intent"
      ON "Transactions"
      USING BTREE ((data#>>'{charge,payment_intent}') DESC)
      WHERE data#>>'{charge,payment_intent}' IS NOT NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__stripe_charge_payment_intent"
    `);
  },
};
