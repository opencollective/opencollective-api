'use strict';

import type { QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface, Sequelize) {
    // Drop the SQL prototype view if present (replaced by this table in #8726).
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "PaymentIntents" CASCADE;`);

    await queryInterface.createTable('PaymentIntents', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      publicId: {
        type: Sequelize.STRING,
        unique: true,
        allowNull: false,
        defaultValue: Sequelize.literal(`oc_nanoid('pi')`),
      },
      primaryTransactionGroup: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM('PENDING', 'PAID', 'REVERSED', 'ERROR'),
        allowNull: false,
      },
      type: {
        type: Sequelize.ENUM(
          // Platform billing
          'PlatformBilling',
          'PlatformBillingTipSettlement',
          // Money out
          'GrantRequest',
          'PaymentRequest',
          'CardCharge',
          // Money in
          'Contribution',
          'AddedMoney',
          // Transfers
          'BalanceTransfer',
          'InternalTransfer',
          // Other
          'Other',
        ),
        allowNull: false,
      },
      PayerCollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      PayeeCollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      HostCollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      InitiatedByCollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      CreatedByUserId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Users' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      paidAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      OrderId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Orders' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      ExpenseId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Expenses' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
      deletedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX "payment_intents__primary_transaction_group"
      ON "PaymentIntents" ("primaryTransactionGroup")
      WHERE "primaryTransactionGroup" IS NOT NULL AND "deletedAt" IS NULL;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX "payment_intents__host_collective_paid_at"
      ON "PaymentIntents" ("HostCollectiveId", "paidAt" DESC, id DESC)
      WHERE "deletedAt" IS NULL;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX "payment_intents__payer_collective_paid_at"
      ON "PaymentIntents" ("PayerCollectiveId", "paidAt" DESC)
      WHERE "deletedAt" IS NULL;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX "payment_intents__payee_collective_paid_at"
      ON "PaymentIntents" ("PayeeCollectiveId", "paidAt" DESC)
      WHERE "deletedAt" IS NULL;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX "payment_intents__order_id"
      ON "PaymentIntents" ("OrderId")
      WHERE "OrderId" IS NOT NULL AND "deletedAt" IS NULL;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX "payment_intents__expense_id"
      ON "PaymentIntents" ("ExpenseId")
      WHERE "ExpenseId" IS NOT NULL AND "deletedAt" IS NULL;
    `);

    // Add PaymentIntentId to Transactions table
    await queryInterface.addColumn('Transactions', 'PaymentIntentId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'PaymentIntents' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      CREATE INDEX "transactions__payment_intent_id"
      ON "Transactions" ("PaymentIntentId")
      WHERE "PaymentIntentId" IS NOT NULL AND "deletedAt" IS NULL;
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.removeColumn('Transactions', 'PaymentIntentId');
    await queryInterface.dropTable('PaymentIntents');
  },
};
