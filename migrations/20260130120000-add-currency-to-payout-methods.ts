'use strict';

import type { QueryInterface } from 'sequelize';

module.exports = {
  async up(queryInterface: QueryInterface, Sequelize) {
    // 1. Add the currency column (nullable to accommodate payout methods without currency)
    await queryInterface.addColumn('PayoutMethods', 'currency', {
      type: Sequelize.STRING(3),
      allowNull: true,
    });

    // 2. Copy existing data from the data JSONB field to the new column
    await queryInterface.sequelize.query(`
      UPDATE "PayoutMethods"
      SET "currency" = data->>'currency'
      WHERE data->>'currency' IS NOT NULL
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.removeColumn('PayoutMethods', 'currency');
  },
};
