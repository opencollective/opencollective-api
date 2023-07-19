'use strict';

import { QueryInterface } from 'sequelize';

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.addIndex('ExpenseItems', ['ExpenseId'], {
      concurrently: true,
      where: { deletedAt: null },
    });

    await queryInterface.addIndex('PaymentMethods', ['CollectiveId'], {
      concurrently: true,
      where: { deletedAt: null },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('ExpenseItems', ['ExpenseId']);
    await queryInterface.removeIndex('ExpenseItems', ['CollectiveId']);
  },
};
