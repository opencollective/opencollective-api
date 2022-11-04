'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "payment_methods__fingerprint"
      ON "PaymentMethods" USING HASH ((data#>>'{fingerprint}'))
      WHERE data#>>'{fingerprint}' IS NOT NULL and "deletedAt" IS NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "payment_methods__fingerprint"
    `);
  },
};
