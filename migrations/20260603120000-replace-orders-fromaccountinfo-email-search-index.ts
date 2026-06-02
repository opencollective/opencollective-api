'use strict';

import type { QueryInterface } from 'sequelize';

/**
 * Orders search updated to use exact match on data.fromAccountInfo.email (emailFields),
 * not ILIKE. Replace the trigram GiST index with a btree index on lower(email).
 */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "Orders_data_fromAccountInfo_email_search_idx";
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "Orders_data_fromAccountInfo_email_search_idx"
      ON "Orders" (lower(("data"#>>'{fromAccountInfo,email}')))
      INCLUDE (
        description,
        tags,
        id,
        "SubscriptionId",
        "createdAt",
        "CollectiveId",
        "FromCollectiveId",
        "CreatedByUserId",
        "status",
        "TierId",
        "interval",
        "totalAmount",
        "currency",
        "PaymentMethodId",
        "deletedAt"
      )
      WHERE "deletedAt" IS NULL
        AND coalesce("data"#>>'{fromAccountInfo,email}', '') <> '';
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "Orders_data_fromAccountInfo_email_search_idx";
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "Orders_data_fromAccountInfo_email_search_idx"
      ON "Orders" USING gist(("data"#>>'{fromAccountInfo,email}') gist_trgm_ops)
      INCLUDE (
        description,
        tags,
        id,
        "SubscriptionId",
        "createdAt",
        "CollectiveId",
        "FromCollectiveId",
        "CreatedByUserId",
        "status",
        "TierId",
        "interval",
        "totalAmount",
        "currency",
        "PaymentMethodId",
        "deletedAt"
      );
    `);
  },
};
