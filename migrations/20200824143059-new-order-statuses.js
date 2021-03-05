'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(
      `UPDATE "Orders"
  SET "status" = 'PLEDGED'
  FROM "Collectives"
  WHERE "Orders"."status" = 'PENDING'
  AND "Orders"."PaymentMethodId" IS NULL
  AND "Collectives"."id" = "Orders"."CollectiveId"
  AND "Collectives"."isActive" = FALSE
  AND "Collectives"."isPledged" = TRUE`,
    );
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(
      `UPDATE "Orders"
  SET "status" = 'PENDING'
  WHERE "status" = 'PLEDGED'`,
    );
  },
};
