'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    let metadata;
    [, metadata] = await queryInterface.sequelize.query(`
      WITH wise AS (SELECT DISTINCT e."HostCollectiveId" FROM "Expenses" e WHERE e."createdAt" > '2024-01-01' AND e.status = 'PAID' AND e.data#>>'{fund,status}' = 'COMPLETED')
      INSERT INTO "PaymentMethods" ("service", "type", "CollectiveId", "saved", "data")
      SELECT 'wise' as "service", 'bank_transfer' as "type", "HostCollectiveId" as "CollectiveId", False as "saved", '{ "migration": "20240130125545-add-expense-payment-method" }'::JSONB as "data" FROM wise ON CONFLICT DO NOTHING;
    `);
    console.info(metadata.rowCount, 'wise payment methods created');
    [, metadata] = await queryInterface.sequelize.query(`
      UPDATE "Expenses" as e
      SET "PaymentMethodId" = pm.id, "data" = '{ "migration": "20240130125545-add-expense-payment-method" }'::JSONB || e.data
      FROM "PaymentMethods" pm
      WHERE
        e."deletedAt" IS NULL AND e."createdAt" >= '2024-01-01' AND e.status = 'PAID' AND e.data#>>'{fund,status}' = 'COMPLETED'
        AND pm."service" = 'wise' AND pm.type = 'bank_transfer' AND pm."CollectiveId" = e."HostCollectiveId"
      RETURNING e.*;
    `);
    console.info(metadata.rowCount, 'expenses updated with wise payment method');

    [, metadata] = await queryInterface.sequelize.query(`
      WITH stripevirtualcard AS (SELECT DISTINCT e."HostCollectiveId" FROM "Expenses" e WHERE e."createdAt" > '2024-01-01' AND e.status = 'PAID' AND e.data#>>'{transaction,card}' IS NOT NULL)
      INSERT INTO "PaymentMethods" ("service", "type", "CollectiveId", "saved", "data")
      SELECT 'stripe' as "service", 'virtual_card' as "type", "HostCollectiveId" as "CollectiveId", False as "saved", '{ "migration": "20240130125545-add-expense-payment-method" }'::JSONB as "data" FROM stripevirtualcard ON CONFLICT DO NOTHING;
    `);
    console.info(metadata.rowCount, 'stripe virtual card payment methods created');
    [, metadata] = await queryInterface.sequelize.query(`
      UPDATE "Expenses" as e
      SET "PaymentMethodId" = pm.id, "data" = '{ "migration": "20240130125545-add-expense-payment-method" }'::JSONB || e.data
      FROM "PaymentMethods" pm
      WHERE
        e."deletedAt" IS NULL AND e."createdAt" > '2024-01-01' AND e.status = 'PAID' AND e.data#>>'{transaction,card}' IS NOT NULL
        AND pm."service" = 'stripe' AND pm.type = 'virtual_card' AND pm."CollectiveId" = e."HostCollectiveId"
      RETURNING e.*;
    `);
    console.info(metadata.rowCount, 'expenses updated with stripe virtual card payment method');

    [, metadata] = await queryInterface.sequelize.query(`
      WITH paypalpayouts AS (SELECT DISTINCT e."HostCollectiveId" FROM "Expenses" e WHERE e."createdAt" > '2024-01-01' AND e.status = 'PAID' AND e.data#>>'{payout_batch_id}' IS NOT NULL)
      INSERT INTO "PaymentMethods" ("service", "type", "CollectiveId", "saved", "data")
      SELECT 'paypal' as "service", 'payout' as "type", "HostCollectiveId" as "CollectiveId", False as "saved", '{ "migration": "20240130125545-add-expense-payment-method" }'::JSONB as "data" FROM paypalpayouts ON CONFLICT DO NOTHING;
    `);
    console.info(metadata.rowCount, 'paypal payout payment methods created');
    [, metadata] = await queryInterface.sequelize.query(`
      UPDATE "Expenses" as e
      SET "PaymentMethodId" = pm.id, "data" = '{ "migration": "20240130125545-add-expense-payment-method" }'::JSONB || e.data
      FROM "PaymentMethods" pm
      WHERE
        e."deletedAt" IS NULL AND e."createdAt" > '2024-01-01' AND e.status = 'PAID' AND e.data#>>'{payout_batch_id}' IS NOT NULL
        AND pm."service" = 'paypal' AND pm.type = 'payout' AND pm."CollectiveId" = e."HostCollectiveId"
      RETURNING e.*;
    `);
    console.info(metadata.rowCount, 'expenses updated with paypal payout payment method');

    [, metadata] = await queryInterface.sequelize.query(`
      WITH paypaladaptive AS (SELECT DISTINCT e."HostCollectiveId" FROM "Expenses" e INNER JOIN "PayoutMethods" as po ON po.id = e."PayoutMethodId" WHERE e."createdAt" > '2024-01-01' AND e.status = 'PAID' AND e.data#>>'{payout_batch_id}' IS NULL AND e.data#>>'{quote,id}' IS NULL AND e.data#>>'{transaction,id}' IS NULL AND po.type = 'PAYPAL')
      INSERT INTO "PaymentMethods" ("service", "type", "CollectiveId", "saved", "data")
      SELECT 'paypal' as "service", 'adaptive' as "type", "HostCollectiveId" as "CollectiveId", False as "saved", '{ "migration": "20240130125545-add-expense-payment-method" }'::JSONB as "data" FROM paypaladaptive ON CONFLICT DO NOTHING;
    `);
    console.info(metadata.rowCount, 'paypal adaptive payment methods created');
    [, metadata] = await queryInterface.sequelize.query(`
      UPDATE "Expenses" as e
      SET "PaymentMethodId" = pm.id, "data" = '{ "migration": "20240130125545-add-expense-payment-method" }'::JSONB || e.data
      FROM "PaymentMethods" pm, "PayoutMethods" po
      WHERE
        e."deletedAt" IS NULL AND e."createdAt" > '2024-01-01' AND e.status = 'PAID' AND e.data#>>'{payout_batch_id}' IS NULL AND e.data#>>'{quote,id}' IS NULL AND e.data#>>'{transaction,id}' IS NULL
        AND po.id = e."PayoutMethodId" AND po.type = 'PAYPAL'
        AND pm."service" = 'paypal' AND pm.type = 'adaptive' AND pm."CollectiveId" = e."HostCollectiveId"
      RETURNING e.*;
    `);
    console.info(metadata.rowCount, 'expenses updated with paypal adaptive payment method');

    [, metadata] = await queryInterface.sequelize.query(`
      WITH accountbalance AS (SELECT DISTINCT e."HostCollectiveId" FROM "Expenses" e INNER JOIN "PayoutMethods" as po ON po.id = e."PayoutMethodId" WHERE e."createdAt" > '2024-01-01' AND e.status = 'PAID' AND po.type = 'ACCOUNT_BALANCE')
      INSERT INTO "PaymentMethods" ("service", "type", "CollectiveId", "saved", "data")
      SELECT 'opencollective' as "service", 'collective' as "type", "HostCollectiveId" as "CollectiveId", False as "saved", '{ "migration": "20240130125545-add-expense-payment-method" }'::JSONB as "data" FROM accountbalance ON CONFLICT DO NOTHING;
    `);
    console.info(metadata.rowCount, 'account balance methods created');
    [, metadata] = await queryInterface.sequelize.query(`
      UPDATE "Expenses" as e
      SET "PaymentMethodId" = pm.id, "data" = '{ "migration": "20240130125545-add-expense-payment-method" }'::JSONB || e.data
      FROM "PaymentMethods" pm, "PayoutMethods" po
      WHERE
        e."deletedAt" IS NULL AND e."createdAt" > '2024-01-01' AND e.status = 'PAID'
        AND po.id = e."PayoutMethodId" AND po.type = 'ACCOUNT_BALANCE'
        AND pm."CollectiveId" = e."HostCollectiveId" AND pm."service" = 'opencollective' AND pm.type = 'collective'
      RETURNING e.*;
    `);
    console.info(metadata.rowCount, 'expenses updated with account balance method');
  },

  async down(queryInterface) {
    let metadata;
    [, metadata] = await queryInterface.sequelize.query(`
      UPDATE "Expenses" as e
      SET "PaymentMethodId" = NULL, "data" = data #- '{migration}'
      WHERE "data"#>>'{migration}' = '20240130125545-add-expense-payment-method';
    `);
    console.info(metadata.rowCount, 'expenses updated with null payment method');

    [, metadata] = await queryInterface.sequelize.query(`
      DELETE FROM "PaymentMethods" WHERE "data"#>>'{migration}' = '20240130125545-add-expense-payment-method' AND (
        ("type" = 'bank_transfer' AND "service" = 'wise') OR
        ("type" = 'virtual_card' AND "service" = 'stripe') OR
        ("type" = 'payout' AND "service" = 'paypal') OR
        ("type" = 'adaptive' AND "service" = 'paypal')
      );
    `);
    console.info(metadata.rowCount, 'payment methods deleted');
  },
};
