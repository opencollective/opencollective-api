'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // See `getPaymentProcessorFeeVendor` in `models/PaymentMethod`
    await queryInterface.sequelize.query(`
      INSERT INTO "Collectives" ("type", "slug", "name", "website", "createdAt", "updatedAt")
      VALUES
        ('VENDOR', 'eu-vat-tax-vendor', 'European VAT', NULL, NOW(), NOW()),
        ('VENDOR', 'nz-gst-tax-vendor', 'New Zealand GST', NULL, NOW(), NOW()),
        ('VENDOR', 'other-tax-vendor', 'Other Tax', NULL, NOW(), NOW());
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM "Collectives" WHERE "slug" IN (
        'eu-vat-tax-vendor',
        'nz-gst-tax-vendor',
        'other-tax-vendor'
      );
    `);
  },
};
