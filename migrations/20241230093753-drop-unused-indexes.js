'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // We can

    for (const indexName of [
      'transactions__collective_id_createdAt', // Table: Transactions. Size: 351 MB
      'transactions__host_collective_id_createdAt', // Table: Transactions. Size: 246 MB
      'transactions__hostCollective_clearedAt', // Table: Transactions. Size: 127 MB
      'activities__from_collective_id', // Table: Activities. Size: 100 MB. Replaced by activities__from_collective_id_simple, which skips the transactions activities.
      'activities__host_collective_id', // Table: Activities. Size: 88 MB. Replaced by activities__host_collective_id_simple, which skips the transactions activities.
      'orders__req_ip', // Table: Orders. Size: 21 MB. The fraud detection uses redis, not the DB.
      'payment_methods__fingerprint', // Table: PaymentMethods. Size: 16 MB
      // 'UploadedFiles_s3_hash', // Table: UploadedFiles. Size: 16 MB. This one is unused because we've disabled Klippa, but we want to keep it in case we re-enable the feature.
      'transaction_wise_transfer_id', // Table: Transactions. Size: 8144 kB
      'expense_tag_stats_tag', // View: ExpenseTagStats. Size: 6864 kB. We're seemingly never fetching BY tag.
      // 'uploaded_files__created_by_user_id', // Table: UploadedFiles. Size: 5792 kB. For Klippa rate-limiting, keeping in case we re-enable an AI feature.
      'expenses_data_stripe_virtual_card_transaction_id', // Table: Expenses. Size: 1104 kB
      'expenses_data_paypal_transaction_id', // Table: Expenses. Size: 1048 kB
      'wise_batchgroup_status', // Table: Expenses. Size: 648 kB
      'privacy_transfer_id', // Table: Transactions. Size: 16 kB
      'Subscriptions_lastChargedAt', // Table: Subscriptions. Size: 16 kB
    ]) {
      console.time(`Dropping index ${indexName}`);
      await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`);
      console.timeEnd(`Dropping index ${indexName}`);
    }
  },

  async down(queryInterface, Sequelize) {
    console.warn(
      'This migration has no rollback. If you want to restore the legacy indexes, look at the old migrations.',
    );
  },
};
