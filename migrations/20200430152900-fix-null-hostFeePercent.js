'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "hostFeePercent" = 0
      WHERE "deletedAt" IS NULL
      AND "isHostAccount" IS TRUE
      AND "hostFeePercent" IS NULL;
    `);
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" as c
      SET "hostFeePercent" = host."hostFeePercent"
      FROM "Collectives" as host
      WHERE c."deletedAt" IS NULL
      AND c."hostFeePercent" IS NULL
      AND c."HostCollectiveId" = host.id;
    `);
  },

  down: () => {},
};
