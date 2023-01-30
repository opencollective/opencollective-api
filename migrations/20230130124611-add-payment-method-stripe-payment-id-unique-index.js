'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX "PaymentMethods__stripePaymentMethodId" ON "PaymentMethods"(("data"->>'stripePaymentMethodId'))
      WHERE "data"->>'stripePaymentMethodId' IS NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('PaymentMethods', 'PaymentMethods__stripePaymentMethodId');
  },
};
