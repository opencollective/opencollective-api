'use strict';

import type { QueryInterface } from 'sequelize';
import { DataTypes } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      for (const table of ['Subscriptions', 'SubscriptionHistories']) {
        await queryInterface.removeColumn(table, 'quantity', { transaction });
      }
    });
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      for (const table of ['Subscriptions', 'SubscriptionHistories']) {
        await queryInterface.addColumn(
          table,
          'quantity',
          {
            type: DataTypes.INTEGER,
            allowNull: true,
          },
          { transaction },
        );
      }
    });
  },
};
