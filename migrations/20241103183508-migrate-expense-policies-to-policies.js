'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" SET
      data = jsonb_set(
        data,
        '{policies,EXPENSE_POLICIES}',
        jsonb_build_object(
          'invoicePolicy', "expensePolicy",
          'receiptPolicy', "expensePolicy",
          'titlePolicy', ''
        )
      )
      WHERE TRIM("expensePolicy") <> '' AND "expensePolicy" IS NOT NULL;
    `);

    await queryInterface.removeColumn('Collectives', 'expensePolicy');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('Collectives', 'expensePolicy', {
      type: Sequelize.STRING,
    });
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" SET
      data = data #- '{policies,EXPENSE_POLICIES}',
      "expensePolicy" = data#>>'{policies,EXPENSE_POLICIES,invoicePolicy}'
      WHERE data#>'{policies,EXPENSE_POLICIES}' IS NOT NULL;
    `);
  },
};
