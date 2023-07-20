'use strict';

import { QueryInterface } from 'sequelize';

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.addIndex('Expenses', ['VirtualCardId'], {
      concurrently: true,
      where: { deletedAt: null },
    });
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.removeIndex('Expenses', ['VirtualCardId']);
  },
};
