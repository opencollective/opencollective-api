'use strict';

import type { QueryInterface } from 'sequelize';

const getBackfillDataSQLUp = (table: string) => `
  UPDATE "${table}"
  SET data = data
    || CASE
      WHEN data ? 'paymentIntent' AND NOT data ? 'stripePaymentIntent'
      THEN jsonb_build_object('stripePaymentIntent', data->'paymentIntent')
      ELSE '{}'::jsonb
    END
    || CASE
      WHEN data ? 'previousPaymentIntents' AND NOT data ? 'previousStripePaymentIntents'
      THEN jsonb_build_object('previousStripePaymentIntents', data->'previousPaymentIntents')
      ELSE '{}'::jsonb
    END
  WHERE "deletedAt" IS NULL
    AND (
      data ? 'paymentIntent'
      OR data ? 'previousPaymentIntents'
    );
`;

const getRemoveLegacyKeysSQL = (table: string) => `
  UPDATE "${table}"
  SET data = data - 'paymentIntent' - 'previousPaymentIntents'
  WHERE "deletedAt" IS NULL
    AND (data ? 'paymentIntent' OR data ? 'previousPaymentIntents');
`;

const getRestoreLegacyKeysSQL = (table: string) => `
  UPDATE "${table}"
  SET data = data
    || CASE
      WHEN data ? 'stripePaymentIntent' AND NOT data ? 'paymentIntent'
      THEN jsonb_build_object('paymentIntent', data->'stripePaymentIntent')
      ELSE '{}'::jsonb
    END
    || CASE
      WHEN data ? 'previousStripePaymentIntents' AND NOT data ? 'previousPaymentIntents'
      THEN jsonb_build_object('previousPaymentIntents', data->'previousStripePaymentIntents')
      ELSE '{}'::jsonb
    END
  WHERE "deletedAt" IS NULL
    AND (
      data ? 'stripePaymentIntent'
      OR data ? 'previousStripePaymentIntents'
    );
`;

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(getBackfillDataSQLUp('Orders'));
    await queryInterface.sequelize.query(getBackfillDataSQLUp('Expenses'));

    await queryInterface.sequelize.query(getRemoveLegacyKeysSQL('Orders'));
    await queryInterface.sequelize.query(getRemoveLegacyKeysSQL('Expenses'));

    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "orders__data__payment_intent_id"
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "expenses__data__payment_intent_id"
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders__data__payment_intent_id"
      ON "Orders" USING HASH ((data#>>'{paymentIntent,id}'))
      WHERE data#>>'{paymentIntent,id}' IS NOT NULL and "deletedAt" IS NULL;
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "expenses__data__payment_intent_id"
      ON "Expenses" USING HASH ((data#>>'{paymentIntent,id}'))
      WHERE data#>>'{paymentIntent,id}' IS NOT NULL and "deletedAt" IS NULL;
    `);

    await queryInterface.sequelize.query(getRestoreLegacyKeysSQL('Orders'));
    await queryInterface.sequelize.query(getRestoreLegacyKeysSQL('Expenses'));
  },
};
