'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY stripe_charge_id 
      ON "Transactions" (((data -> 'charge' ->> 'id')::text)) 
      WHERE (data -> 'charge' ->> 'id') IS NOT NULL`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "stripe_charge_id"`);
  },
};
