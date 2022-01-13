'use strict';

module.exports = {
  up: async queryInterface => {
    // Fill in collective.legalName when the info is set in the Users table but not on the Collectives table
    // We fill legalName rather than name cause users may want to keep this private
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" c
      SET "legalName" = concat_ws(' ', COALESCE(u."firstName", ''), COALESCE(u."lastName", '')) 
      FROM "Users" u 
      WHERE u."CollectiveId" = c.id
      AND u."deletedAt" IS NULL
      AND c."deletedAt" IS NULL
      AND (c."name" IS NULL OR LENGTH(c."name") = 0)
      AND (c."legalName" IS NULL OR LENGTH(c."legalName") = 0)
      AND (LENGTH(COALESCE(u."firstName", '')) > 0 OR LENGTH(COALESCE(u."lastName", '')) > 0)
    `);

    // Remove firstName/lastName columns 👋
    // We don't remove them from `UserHistories` to keep a backup, just in case
    await queryInterface.sequelize.query(`
      ALTER TABLE "Users"
      DROP COLUMN "firstName",
      DROP COLUMN "lastName"
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Users', 'firstName', { type: Sequelize.STRING });
    await queryInterface.addColumn('Users', 'lastName', { type: Sequelize.STRING });
  },
};
