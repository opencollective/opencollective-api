'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE
        "PaymentMethods" pm
      SET
        "CollectiveId" = o."FromCollectiveId",
        "saved" = FALSE,
        -- Set a special flag in data for easier debugging & rollback
        "data" = JSONB_SET(
          COALESCE(pm."data", '{}'::jsonb),
          '{CollectiveIdMigratedIn}',
          '"20210503103943-fill-payment-methods-collective-id"'
        )
      FROM
        "Orders" o
      WHERE
        o."PaymentMethodId" = pm.id
        AND pm."CollectiveId" IS NULL
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE
        "PaymentMethods"
      SET
        "CollectiveId" = NULL
      WHERE
        "data" ->> 'CollectiveIdMigratedIn' = '20210503103943-fill-payment-methods-collective-id'
    `);
  },
};
