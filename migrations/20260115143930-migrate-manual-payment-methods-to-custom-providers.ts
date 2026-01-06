'use strict';

import { Migration } from 'sequelize-cli';
import { v7 as uuidv7 } from 'uuid';

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
      LEFT JOIN "PayoutMethods" pm ON pm.CollectiveId = c.id AND pm.type = 'BANK_ACCOUNT' AND pm.data->>'isManualBankTransfer' = 'true'
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
      const customProvider = {
        id: uuidv7(),
        type: 'BANK_TRANSFER',
        name: 'Bank Transfer', // TODO: Is there something better we can use? Or set null, to benefit from i18n?
        instructions: existingManualPaymentMethod.instructions,
      };

      // TODO: Backup old settings
      // TODO: Import the payout method details in the `customProvider` object and store in `settings.customPaymentProviders`
      // TODO: AS A FOLLOW-UP MIGRATION DEPLOYED SEPARATELY: remove old customInstructions from settings
    }
  },

  async down(queryInterface) {
    // TODO: We don't touch the payout method, so all we need is to restore from customPaymentProviders to settings.paymentMethods.manual.instructions
  },
} as Migration;
