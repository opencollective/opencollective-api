'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Expenses"
      SET "status" = 'APPROVED'
      FROM "Collectives" c, "Collectives" h
      WHERE
        "Expenses"."status" = 'SCHEDULED_FOR_PAYMENT'
        AND "Expenses"."legacyPayoutMethod" = 'other'
        AND c."id" = "Expenses"."CollectiveId"
        AND h."id" = c."HostCollectiveId"
        AND h."settings"#>>'{transferwise,ott}' = 'true';
    `);
  },

  down: async () => {
    //
  },
};
