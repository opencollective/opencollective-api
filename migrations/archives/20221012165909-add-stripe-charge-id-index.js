'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__stripe_charge_id"
      ON "Transactions"
      USING BTREE ((data#>>'{charge,id}') DESC)
      WHERE data#>>'{charge,id}' IS NOT NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__stripe_charge_id"
    `);
  },
};
