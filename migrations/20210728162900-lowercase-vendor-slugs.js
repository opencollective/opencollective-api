'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
        SET "slug" = LOWER("slug")
      WHERE
        "type" = 'VENDOR';
    `);
    await queryInterface.sequelize.query(`
      UPDATE "CollectiveHistories"
        SET "slug" = LOWER("slug")
      WHERE
        "type" = 'VENDOR';
    `);
  },
  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
        SET "slug" = UPPER("slug")
      WHERE
        "type" = 'VENDOR';
    `);
    await queryInterface.sequelize.query(`
      UPDATE "CollectiveHistories"
        SET "slug" = UPPER("slug")
      WHERE
        "type" = 'VENDOR';
    `);
  },
};
