'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__data__dispute_id"
      ON "Transactions" USING HASH ((data#>>'{dispute,id}'))
      WHERE data#>>'{dispute,id}' IS NOT NULL and "deletedAt" IS NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__data__dispute_id"
    `);
  },
};
