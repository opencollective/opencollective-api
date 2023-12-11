'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addColumn('AccountingCategories', 'expensesTypes', {
      type: '"public"."enum_Expenses_type"[]', // Reference to the `Expense.type` enum
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('AccountingCategories', 'expensesTypes');
  },
};
