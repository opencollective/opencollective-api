'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(`
      UPDATE  "Collectives"
      SET     description = mission
      WHERE   (mission IS NOT NULL AND LENGTH(mission) > 0)
      AND     (description IS NULL OR LENGTH(description) = 0)
    `);

    await queryInterface.removeColumn('Collectives', 'mission');
    await queryInterface.removeColumn('CollectiveHistories', 'mission');
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Collectives', 'mission', { type: DataTypes.STRING(128) });
    await queryInterface.addColumn('CollectiveHistories', 'mission', { type: DataTypes.STRING(128) });
  },
};
