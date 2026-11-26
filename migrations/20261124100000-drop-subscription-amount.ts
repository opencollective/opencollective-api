'use strict';

import { QueryInterface } from 'sequelize';

/**
 * `Subscriptions.amount` duplicated `Orders.totalAmount` and could go stale. The code stopped reading and writing it
 * (opencollective/opencollective-api#12634), so drop it, along with its copy in the temporal history table.
 */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "Subscriptions" DROP COLUMN IF EXISTS "amount";
      ALTER TABLE "SubscriptionHistories" DROP COLUMN IF EXISTS "amount";
    `);
  },

  async down(queryInterface: QueryInterface) {
    // The previous values are lost: restore the column from the amount of the order that owns each subscription
    await queryInterface.sequelize.query(`
      ALTER TABLE "Subscriptions" ADD COLUMN IF NOT EXISTS "amount" INTEGER;
      ALTER TABLE "SubscriptionHistories" ADD COLUMN IF NOT EXISTS "amount" INTEGER;

      UPDATE "Subscriptions" s
      SET "amount" = o."totalAmount"
      FROM "Orders" o
      WHERE o."SubscriptionId" = s.id;
    `);
  },
};
