'use strict';

import { Migration } from 'sequelize-cli';
import { v7 as uuidv7 } from 'uuid';

import { CustomPaymentProvider } from '../server/lib/collectivelib';

/**
 * This migration only creates the `settings.customPaymentProviders` array based on the existing manual payment instructions.
 * It does not remove the old `settings.paymentMethods.manual.instructions` key to prevent breaking changes when deploying.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Get all accounts that have manual payment instructions
    const entries: Array<{
      collectiveId: number;
      payoutMethodId: number;
      payoutMethodData: { isManualBankTransfer: boolean };
      collectiveSettings: { paymentMethods: { manual: { instructions: string } } };
    }> = await queryInterface.sequelize.query(
      `
      SELECT c.id as "collectiveId", c.settings as "collectiveSettings", pm.id as "payoutMethodId", pm.data as "payoutMethodData"
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
      const settings = entry.collectiveSettings;
      const existingManualPaymentMethod = settings.paymentMethods.manual;

      // Create a custom payment provider entry from the existing manual instructions
      const customProvider: CustomPaymentProvider = {
        id: uuidv7(),
        type: entry.payoutMethodData ? 'BANK_TRANSFER' : 'OTHER',
        name: 'Bank Transfer (manual)', // To match the label we're using in the contribution flow
        icon: 'Landmark',
        instructions: existingManualPaymentMethod.instructions,
        accountDetails: entry.payoutMethodData,
      };

      await queryInterface.sequelize.query(
        `
        UPDATE "Collectives"
        SET "settings" = "settings" || jsonb_build_object('customPaymentProviders', :customProvider)
        WHERE id = :collectiveId
        `,
        {
          type: Sequelize.QueryTypes.UPDATE,
          replacements: {
            collectiveId: entry.collectiveId,
            customProvider: customProvider,
          },
        },
      );
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      `
      UPDATE "Collectives"
      SET "settings" = "settings" - 'customPaymentProviders'
      WHERE "settings" -> 'customPaymentProviders' IS NOT NULL
      `,
      {
        type: Sequelize.QueryTypes.UPDATE,
      },
    );
  },
} as Migration;
