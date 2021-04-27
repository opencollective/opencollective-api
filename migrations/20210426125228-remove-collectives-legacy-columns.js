'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      ALTER TABLE "Collectives"
      DROP COLUMN IF EXISTS "maxAmount",
      DROP COLUMN IF EXISTS "mission",
      DROP COLUMN IF EXISTS "maxQuantity",
      DROP COLUMN IF EXISTS "isSupercollective"
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE "CollectiveHistories"
      DROP COLUMN IF EXISTS "maxAmount",
      DROP COLUMN IF EXISTS "mission",
      DROP COLUMN IF EXISTS "maxQuantity",
      DROP COLUMN IF EXISTS "isSupercollective"
    `);
  },

  down: async (queryInterface, Sequelize) => {
    // isSupercollective
    await queryInterface.addColumn('CollectiveHistories', 'isSupercollective', { type: Sequelize.BOOLEAN });
    await queryInterface.addColumn('Collectives', 'isSupercollective', { type: Sequelize.BOOLEAN });

    // Max amount
    await queryInterface.addColumn('CollectiveHistories', 'maxAmount', { type: Sequelize.INTEGER });
    await queryInterface.addColumn('Collectives', 'maxAmount', { type: Sequelize.INTEGER });

    // Max quantity
    await queryInterface.addColumn('CollectiveHistories', 'maxQuantity', { type: Sequelize.INTEGER });
    await queryInterface.addColumn('Collectives', 'maxQuantity', { type: Sequelize.INTEGER });

    // Mission
    await queryInterface.addColumn('CollectiveHistories', 'mission', { type: Sequelize.STRING(128) });
    await queryInterface.addColumn('Collectives', 'mission', { type: Sequelize.STRING(128) });
  },
};
