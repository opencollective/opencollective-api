'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('PaymentMethods', ['uuid'], {
      concurrently: true,
      where: { deletedAt: null },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('PaymentMethods', ['uuid']);
  },
};
