'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TYPE "enum_PayoutMethods_type" ADD VALUE IF NOT EXISTS \'STRIPE\';');

    await queryInterface.sequelize.query(`
      INSERT INTO "PayoutMethods"
        ("CollectiveId", "CreatedByUserId", "isSaved", "createdAt", "updatedAt", "name", "type", 
          "data")
      SELECT "CollectiveId", "CreatedByUserId", true, NOW(), NOW(), username, 'STRIPE', 
          jsonb_build_object(
            'connectedAccountId', id, 
            'stripeAccountId', username,
            'publishableKey', data#>'{publishableKey}',
            'currency', (select currency from "Collectives" where id = "CollectiveId" limit 1)
          )
      FROM "ConnectedAccounts"
      WHERE "service" = 'stripe'
      AND "deletedAt" is NULL 
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM "PayoutMethods" where "type" = 'STRIPE'
    `);
  },
};
