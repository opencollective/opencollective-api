'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Collectives', 'hasHosting', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "hasHosting" = TRUE
      WHERE "isHostAccount" = TRUE
        AND (
          "settings"->>'canHostAccounts' IS NULL
          OR ("settings"->>'canHostAccounts')::boolean != FALSE
        )
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Collectives', 'hasHosting');
  },
};
