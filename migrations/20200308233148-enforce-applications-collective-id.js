'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(`
      UPDATE ONLY "Applications" a
      SET "CollectiveId" = u."CollectiveId"
      FROM "Users" u
      WHERE u.id = a."CreatedByUserId"
      AND a."CollectiveId" IS NULL;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE "Applications" ALTER COLUMN "CollectiveId" SET NOT NULL;
    `);
  },

  down: async (queryInterface, Sequelize) => {
    // We can't completely revert
    await queryInterface.sequelize.query(`
      ALTER TABLE "Applications" ALTER COLUMN "CollectiveId" INT NULL;
    `);
  },
};
