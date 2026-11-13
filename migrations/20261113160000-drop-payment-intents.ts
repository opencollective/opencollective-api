'use strict';

import type { QueryInterface } from 'sequelize';

/**
 * Drops the database objects of the Payment Intents prototype (opencollective/opencollective#9016).
 *
 * Must only be deployed once the code that removed the `PaymentIntent` model is live: migrations run before the new
 * code starts, and the previous version selected `Transactions.PaymentIntentId` on every query.
 *
 * `DROP COLUMN` only updates the catalog (no table rewrite) and also drops `transactions__payment_intent_id` and the
 * foreign key, but it needs a short `ACCESS EXCLUSIVE` lock on both `Transactions` and `PaymentIntents`. The lock
 * timeout makes the migration fail fast rather than queue behind a long transaction and block the ledger.
 */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '10s'`, { transaction });
      await queryInterface.sequelize.query(`ALTER TABLE "Transactions" DROP COLUMN IF EXISTS "PaymentIntentId"`, {
        transaction,
      });
      await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "PaymentIntents"`, { transaction });
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_PaymentIntents_status"`, { transaction });
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_PaymentIntents_type"`, { transaction });
    });
  },

  /**
   * Restores the empty structure (see `20260610120000-create-payment-intents` and
   * `20260708120000-add-payment-intent-canceled-status`). The data is not restored.
   */
  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE "enum_PaymentIntents_status" AS ENUM ('PENDING', 'PAID', 'REVERSED', 'ERROR', 'CANCELED');

      CREATE TYPE "enum_PaymentIntents_type" AS ENUM (
        'PlatformBilling', 'PlatformBillingTipSettlement', 'GrantRequest', 'PaymentRequest', 'CardCharge',
        'Contribution', 'AddedMoney', 'BalanceTransfer', 'InternalTransfer', 'Other'
      );

      CREATE TABLE "PaymentIntents" (
        "id" SERIAL PRIMARY KEY,
        "publicId" VARCHAR(255) NOT NULL UNIQUE DEFAULT oc_nanoid('pi'),
        "primaryTransactionGroup" UUID,
        "status" "enum_PaymentIntents_status" NOT NULL,
        "type" "enum_PaymentIntents_type" NOT NULL,
        "PayerCollectiveId" INTEGER REFERENCES "Collectives" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
        "PayeeCollectiveId" INTEGER REFERENCES "Collectives" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
        "HostCollectiveId" INTEGER REFERENCES "Collectives" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
        "InitiatedByCollectiveId" INTEGER REFERENCES "Collectives" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
        "CreatedByUserId" INTEGER REFERENCES "Users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
        "description" TEXT,
        "paidAt" TIMESTAMP WITH TIME ZONE,
        "OrderId" INTEGER REFERENCES "Orders" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
        "ExpenseId" INTEGER REFERENCES "Expenses" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "deletedAt" TIMESTAMP WITH TIME ZONE
      );

      CREATE UNIQUE INDEX "payment_intents__primary_transaction_group"
        ON "PaymentIntents" ("primaryTransactionGroup")
        WHERE "primaryTransactionGroup" IS NOT NULL AND "deletedAt" IS NULL;
      CREATE INDEX "payment_intents__host_collective_paid_at"
        ON "PaymentIntents" ("HostCollectiveId", "paidAt" DESC, id DESC) WHERE "deletedAt" IS NULL;
      CREATE INDEX "payment_intents__payer_collective_paid_at"
        ON "PaymentIntents" ("PayerCollectiveId", "paidAt" DESC) WHERE "deletedAt" IS NULL;
      CREATE INDEX "payment_intents__payee_collective_paid_at"
        ON "PaymentIntents" ("PayeeCollectiveId", "paidAt" DESC) WHERE "deletedAt" IS NULL;
      CREATE INDEX "payment_intents__order_id"
        ON "PaymentIntents" ("OrderId") WHERE "OrderId" IS NOT NULL AND "deletedAt" IS NULL;
      CREATE INDEX "payment_intents__expense_id"
        ON "PaymentIntents" ("ExpenseId") WHERE "ExpenseId" IS NOT NULL AND "deletedAt" IS NULL;

      ALTER TABLE "Transactions"
        ADD COLUMN "PaymentIntentId" INTEGER REFERENCES "PaymentIntents" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
      CREATE INDEX "transactions__payment_intent_id"
        ON "Transactions" ("PaymentIntentId") WHERE "PaymentIntentId" IS NOT NULL AND "deletedAt" IS NULL;
    `);
  },
};
