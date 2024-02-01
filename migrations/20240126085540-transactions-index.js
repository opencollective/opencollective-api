'use strict';

module.exports = {
  up: async queryInterface => {
    // Host Unsorted
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__host_collective_id"
      ON "Transactions"("HostCollectiveId")
      WHERE "deletedAt" IS NULL AND "HostCollectiveId" IS NOT NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transaction__host_collective_id"
    `);

    // Collective Unsorted
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__collective_id"
      ON "Transactions"("CollectiveId")
      WHERE "deletedAt" IS NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "Transactions_GroupId"
    `);
    // Collective Sorted
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__collective_id_createdAt"
      ON "Transactions"("CollectiveId", ROUND(EXTRACT(epoch FROM "createdAt" AT TIME ZONE 'UTC') / 10) DESC)
      WHERE "deletedAt" IS NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__collective_id_sorted"
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__collective_id_created_at_type"
    `);

    // Order
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__order_id"
      ON "Transactions"("OrderId")
      WHERE "deletedAt" IS NULL AND "OrderId" IS NOT NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "DonationId"
    `);

    // PaymentMethod
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__payment_method_id"
      ON "Transactions"("PaymentMethodId")
      WHERE "deletedAt" IS NULL AND "PaymentMethodId" IS NOT NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "PaymentMethodId-type"
    `);

    // Expense
    // Already looking good

    // Indexes that are not looking useful
    // await queryInterface.sequelize.query(`
    //   DROP INDEX IF EXISTS "CollectiveId-FromCollectiveId-type"
    // `);
    // await queryInterface.sequelize.query(`
    //   DROP INDEX IF EXISTS "CollectiveId-type"
    // `);
    // await queryInterface.sequelize.query(`
    //   DROP INDEX IF EXISTS "transactions__created_by_user_id"
    // `);
  },

  down: async queryInterface => {
    // Host Unsorted
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transaction__host_collective_id"
      ON "Transactions"("HostCollectiveId")
      WHERE "deletedAt" IS NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__host_collective_id"
    `);

    // Collective Unsorted
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "Transactions_GroupId"
      ON "Transactions"("CollectiveId", "deletedAt")
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__collective_id"
    `);
    // Collective Sorted
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__collective_id_sorted"
      ON "Transactions"("CollectiveId", "id")
      WHERE "deletedAt" IS NULL
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__collective_id_created_at_type"
      ON "Transactions"("CollectiveId", "createdAt", "type")
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__collective_id_createdAt"
    `);

    // Order
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "DonationId"
      ON "Transactions"("OrderId")
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__order_id "
    `);

    // PaymentMethod
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "PaymentMethodId-type "
      ON "Transactions"("PaymentMethodId", "type", "deletedAt")
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__payment_method_id"
    `);

    // Indexes that were not looking useful
    // await queryInterface.sequelize.query(`
    //   CREATE INDEX CONCURRENTLY IF NOT EXISTS "CollectiveId-FromCollectiveId-type"
    //   ON "Transactions"("CollectiveId", "FromCollectiveId", "deletedAt")
    // `);
    // await queryInterface.sequelize.query(`
    //   CREATE INDEX CONCURRENTLY IF NOT EXISTS "CollectiveId-type"
    //   ON "Transactions"("CollectiveId", "type")
    // `);
    // await queryInterface.sequelize.query(`
    //   CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__created_by_user_id"
    //   ON "Transactions"("CreatedByUserId")
    // `);
  },
};
