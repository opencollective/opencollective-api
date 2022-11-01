'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('PaymentMethods', ['SourcePaymentMethodId'], {
      concurrently: true,
      where: { deletedAt: null },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('PaymentMethods', ['SourcePaymentMethodId']);
  },
};
