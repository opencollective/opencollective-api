'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" SET
        data = jsonb_set(
          data,
          '{policies}',
          '{}'
        )
      WHERE jsonb_typeof(data -> 'policies') = 'array'
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Collectives" SET
      data = jsonb_set(
        COALESCE(data, '{"policies": {}}'),
        '{policies}',
        COALESCE(data#>'{policies}', '{}') ||
        jsonb_build_object('EXPENSE_POLICIES',
          jsonb_build_object(
            'invoicePolicy', COALESCE("expensePolicy", ''),
            'receiptPolicy', COALESCE("expensePolicy", ''),
            'titlePolicy', ''
          )
        )
      )
      WHERE TRIM("expensePolicy") <> '' AND "expensePolicy" IS NOT NULL;
    `);

    await queryInterface.removeColumn('Collectives', 'expensePolicy');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('Collectives', 'expensePolicy', {
      type: Sequelize.TEXT,
    });
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" SET
      data = data #- '{policies,EXPENSE_POLICIES}',
      "expensePolicy" = data#>>'{policies,EXPENSE_POLICIES,invoicePolicy}'
      WHERE data#>'{policies,EXPENSE_POLICIES}' IS NOT NULL;
    `);
  },
};
