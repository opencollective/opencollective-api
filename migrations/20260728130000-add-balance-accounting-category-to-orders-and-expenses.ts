'use strict';

import { DataTypes, Op, QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    for (const table of ['Orders', 'Expenses']) {
      await queryInterface.addColumn(table, 'BalanceAccountingCategoryId', {
        type: DataTypes.INTEGER,
        references: { model: 'AccountingCategories', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      });
      await queryInterface.addIndex(table, ['BalanceAccountingCategoryId'], {
        where: { BalanceAccountingCategoryId: { [Op.ne]: null } },
        name: `${table.toLowerCase()}_balance_accounting_category_id`,
      });
    }

    // History tables mirror the main tables' columns (no FK, per convention)
    for (const table of ['OrderHistories', 'ExpenseHistories']) {
      await queryInterface.addColumn(table, 'BalanceAccountingCategoryId', {
        type: DataTypes.INTEGER,
        allowNull: true,
      });
    }
  },

  async down(queryInterface: QueryInterface) {
    for (const table of ['OrderHistories', 'ExpenseHistories']) {
      await queryInterface.removeColumn(table, 'BalanceAccountingCategoryId');
    }
    for (const table of ['Orders', 'Expenses']) {
      await queryInterface.removeIndex(table, `${table.toLowerCase()}_balance_accounting_category_id`);
      await queryInterface.removeColumn(table, 'BalanceAccountingCategoryId');
    }
  },
};
