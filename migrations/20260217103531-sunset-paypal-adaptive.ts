'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Enable manual paypal payments for affected hosts, to make sure the "PayPal" option keep being surfaced in the
    // submit expense form, even if meant to be paid manually.
    // Impacted hosts:
    // - europe
    // - allforclimate
    // - osgeo-foundation
    // - dosecrets
    // - nfsc
    // - our-sci
    // - mariposasrebeldes
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET settings = jsonb_set(
        COALESCE(settings, '{}'::jsonb),
        '{payouts,enableManualPayPalPayments}',
        'true'::jsonb,
        true
      )
      WHERE id IN (
        SELECT DISTINCT "CollectiveId"
        FROM "PaymentMethods"
        WHERE service = 'paypal'
          AND type = 'adaptive'
          AND "archivedAt" IS NULL
          AND "deletedAt" IS NULL
      )
    `);

    // Archive adaptive payment methods
    await queryInterface.sequelize.query(`
      UPDATE "PaymentMethods"
      SET "archivedAt" = NOW()
      WHERE service = 'paypal'
        AND type = 'adaptive'
        AND "archivedAt" IS NULL
    `);
  },

  async down() {
    console.log('Please revert maually if needed');
  },
};
