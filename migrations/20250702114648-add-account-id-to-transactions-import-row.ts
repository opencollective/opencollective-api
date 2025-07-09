'use strict';

import { Op, QueryInterface } from 'sequelize';

module.exports = {
  up: async (queryInterface: QueryInterface, Sequelize) => {
    await queryInterface.addColumn('TransactionsImportsRows', 'accountId', {
      type: Sequelize.STRING,
      allowNull: true,
    });

    // Create an index on accountId for better query performance
    await queryInterface.addIndex('TransactionsImportsRows', ['accountId'], {
      name: 'transactions_imports_rows_account_id_idx',
      where: {
        accountId: {
          [Op.ne]: null,
        },
      },
    });

    // Migrate existing data from rawValue.account_id to accountId
    await queryInterface.sequelize.query(`
      UPDATE "TransactionsImportsRows" 
      SET "accountId" = "rawValue"->>'account_id'
      WHERE "rawValue"->>'account_id' IS NOT NULL
    `);
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.removeIndex('TransactionsImportsRows', 'transactions_imports_rows_account_id_idx');

    await queryInterface.removeColumn('TransactionsImportsRows', 'accountId');
  },
};
