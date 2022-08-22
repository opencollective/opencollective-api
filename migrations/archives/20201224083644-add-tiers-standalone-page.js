'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Tiers', 'useStandalonePage', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('TierHistories', 'useStandalonePage', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await queryInterface.sequelize.query(`
      UPDATE "Tiers"
      SET "useStandalonePage" = TRUE
      WHERE "longDescription" IS NOT NULL
      AND length("longDescription") > 0
    `);
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Tiers', 'useStandalonePage');
    await queryInterface.removeColumn('TierHistories', 'useStandalonePage');
  },
};
