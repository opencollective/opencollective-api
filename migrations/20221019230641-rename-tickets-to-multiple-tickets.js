'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Tiers"
      SET
        "type" = 'MULTIPLE_TICKET'
      WHERE "type" = 'TICKET';
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE ONLY "Tiers" ALTER COLUMN "type" SET DEFAULT 'MULTIPLE_TICKET';
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Tiers"
      SET
        "type" = 'TICKET'
      WHERE "type" = 'MULTIPLE_TICKET';
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE ONLY "Tiers" ALTER COLUMN "type" SET DEFAULT 'TICKET';
    `);
  },
};
