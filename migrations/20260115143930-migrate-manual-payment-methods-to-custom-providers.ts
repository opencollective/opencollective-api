'use strict';

import type { QueryInterface } from 'sequelize';
import { DataTypes, Op } from 'sequelize';

import { sanitizeManualPaymentProviderInstructions } from '../server/models/ManualPaymentProvider';

/**
 * This migration:
 * 1. Creates the ManualPaymentProviders table
 * 2. Adds ManualPaymentProviderId column to Orders table
 * 3. Migrates existing settings.paymentMethods.manual data to the new table
 */
module.exports = {
  async up(queryInterface: QueryInterface, Sequelize: typeof import('sequelize')) {
    // Part 1 and 2 run only if the table does not exist, to allow for multiple runs in tests that will only cover the migration logic
    // Part 1: Create the ManualPaymentProviders table
    if (!(await queryInterface.tableExists('ManualPaymentProviders'))) {
      await queryInterface.createTable('ManualPaymentProviders', {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
        },
        CollectiveId: {
          type: DataTypes.INTEGER,
          references: { model: 'Collectives', key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
          allowNull: false,
        },
        type: {
          type: DataTypes.ENUM('BANK_TRANSFER', 'OTHER'),
          allowNull: false,
        },
        name: {
          type: DataTypes.STRING,
          allowNull: false,
        },
        instructions: {
          type: DataTypes.TEXT,
          allowNull: false,
        },
        icon: {
          type: DataTypes.STRING,
          allowNull: true,
        },
        data: {
          type: DataTypes.JSONB,
          allowNull: true,
        },
        order: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        archivedAt: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        createdAt: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('NOW()'),
        },
        updatedAt: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('NOW()'),
        },
        deletedAt: {
          type: DataTypes.DATE,
          allowNull: true,
        },
      });

      await queryInterface.addIndex('ManualPaymentProviders', ['CollectiveId']);

      // Part 2: Add ManualPaymentProviderId to Orders table
      await queryInterface.addColumn('OrderHistories', 'ManualPaymentProviderId', {
        type: DataTypes.INTEGER,
        allowNull: true,
      });

      await queryInterface.addColumn('Orders', 'ManualPaymentProviderId', {
        type: DataTypes.INTEGER,
        references: { model: 'ManualPaymentProviders', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      });

      await queryInterface.addIndex('Orders', ['ManualPaymentProviderId'], {
        where: { ManualPaymentProviderId: { [Op.ne]: null } },
      });
    }

    // Part 3: Migrate existing accounts that have manual payment instructions
    const entries: Array<{
      collectiveId: number;
      payoutMethodId: number;
      payoutMethodData: { isManualBankTransfer: boolean };
      collectiveSettings: { paymentMethods: { manual: { instructions: string } } };
    }> = await queryInterface.sequelize.query(
      `
      SELECT c.id as "collectiveId", c.settings as "collectiveSettings", pm.data as "payoutMethodData"
      FROM "Collectives" c
      LEFT JOIN "PayoutMethods" pm ON pm."CollectiveId" = c.id AND pm.type = 'BANK_ACCOUNT' AND pm.data->>'isManualBankTransfer' = 'true'
      WHERE c.settings -> 'paymentMethods' -> 'manual' -> 'instructions' IS NOT NULL
      AND c."deletedAt" IS NULL
      AND pm."deletedAt" IS NULL
      `,
      {
        type: Sequelize.QueryTypes.SELECT,
        raw: true,
      },
    );

    for (const entry of entries) {
      await queryInterface.sequelize.query(
        `
        INSERT INTO "ManualPaymentProviders" ("CollectiveId", "type", "name", "instructions", "icon", "data", "order", "createdAt", "updatedAt")
        VALUES (:collectiveId, :type, :name, :instructions, :icon, :data, :order, NOW(), NOW())
        `,
        {
          type: Sequelize.QueryTypes.INSERT,
          replacements: {
            collectiveId: entry.collectiveId,
            type: 'BANK_TRANSFER',
            name: 'Bank Transfer',
            icon: 'Landmark',
            data: JSON.stringify(entry.payoutMethodData),
            order: 0,
            instructions: sanitizeManualPaymentProviderInstructions(
              `<div>${entry.collectiveSettings.paymentMethods.manual.instructions.replace(/\n/g, '<br/>')}</div>`,
            ),
          },
        },
      );
    }

    // Mark all existing orders with the ManualPaymentProviderId
    await queryInterface.sequelize.query(
      `
      UPDATE "Orders" o
      SET "ManualPaymentProviderId" = mpp.id
      FROM "ManualPaymentProviders" mpp, "Collectives" c
      WHERE o."CollectiveId" = c.id
      AND c."HostCollectiveId" = mpp."CollectiveId"
      AND o."PaymentMethodId" IS NULL
      `,
    );
  },

  async down(queryInterface: QueryInterface) {
    // The original data is not deleted, so no need to re-create it. Just drop the new table and columns
    await queryInterface.removeColumn('Orders', 'ManualPaymentProviderId');
    await queryInterface.removeColumn('OrderHistories', 'ManualPaymentProviderId');
    await queryInterface.dropTable('ManualPaymentProviders');
  },
};
