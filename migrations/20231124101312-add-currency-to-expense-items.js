'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Create new columns
    await queryInterface.addColumn('ExpenseItems', 'currency', {
      type: Sequelize.STRING(3),
      allowNull: false,
      defaultValue: '___', // We're doing that rather than setting to null then enforcing NOT NULL because we could face problems if expenses get updated between the migration & the deployment. Also, it's probably faster.
    });

    await queryInterface.addColumn('ExpenseItems', 'expenseCurrencyFxRate', {
      type: Sequelize.FLOAT,
      allowNull: false,
      defaultValue: 1,
    });

    await queryInterface.addColumn('ExpenseItems', 'expenseCurrencyFxRateSource', {
      type: Sequelize.ENUM('OPENCOLLECTIVE', 'PAYPAL', 'WISE', 'USER'), // See server/graphql/v2/enum/CurrencyExchangeRateSourceType.ts
      allowNull: true,
    });

    // See items currency from expense currency
    await queryInterface.sequelize.query(`
      UPDATE "ExpenseItems"
      SET "currency" = "Expenses"."currency"
      FROM "Expenses"
      WHERE "ExpenseItems"."ExpenseId" = "Expenses"."id"
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('ExpenseItems', 'currency');
    await queryInterface.removeColumn('ExpenseItems', 'expenseCurrencyFxRate');
    await queryInterface.removeColumn('ExpenseItems', 'expenseCurrencyFxRateSource');
  },
};
