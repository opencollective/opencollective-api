'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('VirtualCards', 'spendingLimitAmount', { type: Sequelize.INTEGER });
    await queryInterface.addColumn('VirtualCards', 'spendingLimitInterval', { type: Sequelize.STRING });

    await queryInterface.sequelize.query(
      `
        UPDATE
          "VirtualCards"
        SET
          "spendingLimitInterval" = "data"->>'spend_limit_duration',
          "spendingLimitAmount" = CASE WHEN "data"->>'spend_limit' = '0' THEN null ELSE CAST("data"->>'spend_limit' AS integer) END
      `,
    );
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('VirtualCards', 'spendingLimitAmount');
    await queryInterface.removeColumn('VirtualCards', 'spendingLimitInterval');
  },
};
