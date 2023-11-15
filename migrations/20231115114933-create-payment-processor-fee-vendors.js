'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // See `getPaymentProcessorFeeVendor` in `models/PaymentMethod`
    await queryInterface.sequelize.query(`
      INSERT INTO "Collectives" ("type", "slug", "name", "website", "createdAt", "updatedAt")
      VALUES
        ('VENDOR', 'stripe-payment-processor-vendor', 'Stripe', 'https://stripe.com', NOW(), NOW()),
        ('VENDOR', 'paypal-payment-processor-vendor', 'PayPal', 'https://paypal.com', NOW(), NOW()),
        ('VENDOR', 'wise-payment-processor-vendor', 'Wise', 'https://wise.com', NOW(), NOW()),
        ('VENDOR', 'other-payment-processor-vendor', 'Other Payment Processor', 'https://opencollective.com', NOW(), NOW());
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM "Collectives" WHERE "slug" IN (
        'stripe-payment-processor-vendor',
        'paypal-payment-processor-vendor',
        'wise-payment-processor-vendor',
        'other-payment-processor-vendor'
      );
    `);
  },
};
