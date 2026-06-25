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

const getBackfillDataSQLDown = (table: string) => `
  UPDATE "${table}"
  SET data = data - 'stripePaymentIntent'
  WHERE "deletedAt" IS NULL
    AND data ? 'paymentIntent'
    AND data ? 'stripePaymentIntent';

  UPDATE "${table}"
  SET data = data - 'previousStripePaymentIntents'
  WHERE "deletedAt" IS NULL
    AND data ? 'previousPaymentIntents'
    AND data ? 'previousStripePaymentIntents';
`;

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(getBackfillDataSQLUp('Orders'));
    await queryInterface.sequelize.query(getBackfillDataSQLUp('Expenses'));

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders__data__stripe_payment_intent_id"
      ON "Orders" USING HASH ((data#>>'{stripePaymentIntent,id}'))
      WHERE data#>>'{stripePaymentIntent,id}' IS NOT NULL and "deletedAt" IS NULL;
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "expenses__data__stripe_payment_intent_id"
      ON "Expenses" USING HASH ((data#>>'{stripePaymentIntent,id}'))
      WHERE data#>>'{stripePaymentIntent,id}' IS NOT NULL and "deletedAt" IS NULL;
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "orders__data__stripe_payment_intent_id"
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "expenses__data__stripe_payment_intent_id"
    `);

    await queryInterface.sequelize.query(getBackfillDataSQLDown('Orders'));
    await queryInterface.sequelize.query(getBackfillDataSQLDown('Expenses'));
  },
};
