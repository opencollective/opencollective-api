'use strict';

module.exports = {
  up: async queryInterface => {
    // Update Current Hosts to the previous default which was platformFeePercent=5
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "platformFeePercent" = 5
      WHERE "isHostAccount" IS TRUE
      AND "platformFeePercent" IS NULL
    `);

    // Update Collectives with unset platformFeePercent to their Host platformFeePercent
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "platformFeePercent" = "HostCollectives"."platformFeePercent"
      FROM "Collectives" as "HostCollectives"
      WHERE "HostCollectives"."id" = "Collectives"."HostCollectiveId"
      AND "Collectives"."platformFeePercent" IS NULL
    `);

    // Update Current Hosts to hostFeePercent=0 if they have a bogus value
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "hostFeePercent" = 0
      WHERE "isHostAccount" IS TRUE
      AND "hostFeePercent" IS NULL
    `);

    // Update Collectives with unset hostFeePercent to their Host hostFeePercent
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "hostFeePercent" = "HostCollectives"."hostFeePercent"
      FROM "Collectives" as "HostCollectives"
      WHERE "HostCollectives"."id" = "Collectives"."HostCollectiveId"
      AND "Collectives"."hostFeePercent" IS NULL
    `);

    // Update all unhosted collectives to hostFeePercent=null platformFeePercent=null
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "platformFeePercent" = NULL, "hostFeePercent" = NULL
      WHERE "HostCollectiveId" IS NULL
      AND "type" IN ('COLLECTIVE', 'FUND', 'EVENT', 'PROJECT')
    `);
  },

  down: async () => {
    // No rollback
  },
};
