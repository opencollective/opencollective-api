'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Transactions', 'PlatformTipForTransactionGroup', {
      type: Sequelize.STRING,
      allowNull: true,
    });

    // Migrate all platform tips donated through Stripe
    await queryInterface.sequelize.query(`
      BEGIN;
      with platformfees as (
        select t.*
        from "Transactions" t
        where
          t."deletedAt" is null
          and t."data"->>'isFeesOnTop' = 'true'
          and t."CollectiveId" = 1
          and t."type" = 'CREDIT'
        order by id desc
      ), tgroups as (
        select t."TransactionGroup" as "originalTransactionGroup", pf."TransactionGroup" as "platformTipTransactionGroup"
        from "Transactions" t, platformfees pf
        where pf."OrderId" = t."OrderId" 
        and t."deletedAt" is null
        and t."type" = 'CREDIT'
        and t."CollectiveId" != 1
        and age(t."createdAt", pf."createdAt") > interval '0'
        and age(t."createdAt", pf."createdAt") < interval '1 minute'
      )

      UPDATE "Transactions"
      SET "PlatformTipForTransactionGroup" = tg."originalTransactionGroup"
      FROM "tgroups" tg
      WHERE "TransactionGroup" = tg."platformTipTransactionGroup";
      COMMIT;
    `);
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Transactions', 'PlatformTipForTransactionGroup');
  },
};
