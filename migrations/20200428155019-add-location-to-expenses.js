'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Expenses', 'payeeLocation', { type: Sequelize.JSONB });
    await queryInterface.addColumn('ExpenseHistories', 'payeeLocation', { type: Sequelize.JSONB });

    // Update address and country with collective's values
    await queryInterface.sequelize.query(
      `
        UPDATE  "Expenses" e
        SET     "payeeLocation" = 
          JSONB_SET('{}'::JSONB, '{country}', COALESCE(to_jsonb(c."countryISO"), jsonb 'null')) ||
          JSONB_SET('{}'::JSONB, '{address}', COALESCE(to_jsonb(c."address"), jsonb 'null'))
        FROM
          "Collectives" c
        WHERE
          c."id" = e."FromCollectiveId"
        AND     (
          c."countryISO" IS NOT NULL
          OR c."address" IS NOT NULL
        )
      `,
    );
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Expenses', 'payeeLocation');
    await queryInterface.removeColumn('ExpenseHistories', 'payeeLocation');
  },
};
