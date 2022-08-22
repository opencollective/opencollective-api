'use strict';

module.exports = {
  async up(queryInterface) {
    // Will update:
    // - PayPal subscriptions (paypalSubscriptionId NOT NULL) => no impact, but more future proof
    // - PayPal subscriptions later updated with a credit card (paypalSubscriptionId NULL) => will activate the subscription
    await queryInterface.sequelize.query(`
      UPDATE "Subscriptions"
      SET "activatedAt" = "createdAt"
      WHERE "activatedAt" IS NULL
      AND "isActive" IS TRUE
      AND "deletedAt" IS NULL
      AND "deactivatedAt" IS NULL
      AND "nextChargeDate" IS NOT NULL
    `);
  },

  async down() {
    // Nothing to do
  },
};
