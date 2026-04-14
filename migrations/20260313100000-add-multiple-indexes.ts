'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // The clearExpiredLocks cron job (cron/hourly/90-clear-expired-locks.ts) runs an UPDATE on all
    // non-deleted Orders to clear stale locks older than 30 minutes. Without an index on the
    // lockedAt field stored in data JSONB, this causes a full table scan on every hourly run.
    // In practice, only a handful of orders are locked at any given time, so this index will be
    // tiny and makes the cron essentially instant.
    // Note: we index the raw text value rather than casting to TIMESTAMP because
    // text→timestamp casts are not IMMUTABLE (they are timezone-sensitive). The partial
    // predicate WHERE data->'lockedAt' IS NOT NULL already limits this index to the tiny
    // number of actively-locked orders, so Postgres applies the ::TIMESTAMP comparison
    // on that tiny subset — making the cron essentially instant regardless.
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders__locked_at"
      ON "Orders" ((data->>'lockedAt'))
      WHERE data->'lockedAt' IS NOT NULL AND "deletedAt" IS NULL;
    `);

    // The contributionsAmountTimeSeries query in AccountStats.js drives from
    // Orders.CollectiveId → Transactions.OrderId. After the join, it filters
    // type='CREDIT', kind='CONTRIBUTION', RefundTransactionId IS NULL, and
    // range-filters on COALESCE(clearedAt, createdAt). The existing
    // transactions__order_id index covers the join but not the date range or the
    // type/kind/refund predicates, forcing a scan of all transactions per order.
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__order_contribution_date"
      ON "Transactions" ("OrderId", COALESCE("clearedAt", "createdAt") DESC)
      WHERE "deletedAt" IS NULL
        AND type = 'CREDIT'
        AND kind = 'CONTRIBUTION'
        AND "RefundTransactionId" IS NULL;
    `);

    // The same query also applies Orders.FromCollectiveId NOT IN (:collectiveIds)
    // as an anti-join. A compound index on (CollectiveId, FromCollectiveId) lets
    // Postgres evaluate both filters in a single index scan.
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders__collective_fromcollective"
      ON "Orders" ("CollectiveId", "FromCollectiveId")
      WHERE "deletedAt" IS NULL;
    `);

    // The virtual card refund deduplication check in paymentProviders/utils.ts queries
    // Transactions by CollectiveId and data->>'refundTransactionId'. The query uses text
    // extraction rather than JSONB containment so that this functional index can be used
    // instead of scanning all transaction JSONB blobs for a given collective.
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__data_refund_txn_id"
      ON "Transactions" ((data->>'refundTransactionId'))
      WHERE data->>'refundTransactionId' IS NOT NULL AND "deletedAt" IS NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "orders__locked_at";
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions__order_contribution_date";
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "orders__collective_fromcollective";
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions__data_refund_txn_id";
    `);
  },
};
