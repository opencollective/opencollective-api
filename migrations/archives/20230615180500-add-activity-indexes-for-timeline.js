'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities__payee_id"
      ON "Activities"
      USING BTREE ((data#>>'{payee,id}') DESC)
      WHERE data#>>'{payee,id}' IS NOT NULL;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities__user_id"
      ON "Activities"
      USING BTREE ((data#>>'{user,id}') DESC)
      WHERE data#>>'{user,id}' IS NOT NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "activities__payee_id"
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "activities__user_id"
    `);
  },
};
