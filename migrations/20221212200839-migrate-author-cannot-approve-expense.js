'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET data = 
        data ||
          jsonb_build_object(
            'policies',
            data#>'{policies}' || 
              jsonb_build_object(
                'EXPENSE_AUTHOR_CANNOT_APPROVE',
                jsonb_build_object(
                  'enabled', 
                  CASE WHEN data#>'{policies,EXPENSE_AUTHOR_CANNOT_APPROVE}' = 'null'::jsonb THEN false WHEN data#>'{policies,EXPENSE_AUTHOR_CANNOT_APPROVE}' = 'false'::jsonb THEN false ELSE true END,
                  'amountInCents',
                  0,
                  'appliesToHostedCollectives',
                  false,
                  'appliesToSingleAdminCollectives',
                  false
                )
              )
          )
      WHERE data#>'{policies,EXPENSE_AUTHOR_CANNOT_APPROVE}' is not null;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET data = 
        data ||
          jsonb_build_object(
            'policies',
            data#>'{policies}' || 
              jsonb_build_object(
                'EXPENSE_AUTHOR_CANNOT_APPROVE',
                data#>'{policies,EXPENSE_AUTHOR_CANNOT_APPROVE,enabled}'
              )
          )
      WHERE data#>'{policies,EXPENSE_AUTHOR_CANNOT_APPROVE}' is not null;
    `);
  },
};
