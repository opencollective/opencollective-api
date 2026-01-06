'use strict';

import { v7 as uuidv7 } from 'uuid';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Get all collectives (hosts) that have manual payment instructions
    const [collectives] = await queryInterface.sequelize.query(`
      SELECT id, settings 
      FROM "Collectives" 
      WHERE settings -> 'paymentMethods' -> 'manual' -> 'instructions' IS NOT NULL
      AND "deletedAt" IS NULL
    `);

    for (const collective of collectives) {
      const settings = collective.settings || {};
      const manualInstructions = settings.paymentMethods?.manual?.instructions;

      if (!manualInstructions) {
        continue;
      }

      // Get the host's currency (default to USD if not set)
      const currency = collective.settings?.currency || 'USD';

      // Create a custom payment provider entry from the existing manual instructions
      const customProvider = {
        id: uuidv7(),
        type: 'BANK_TRANSFER',
        currency: currency,
        name: settings.paymentMethods?.manual?.title || 'Bank Transfer',
        accountDetails: '', // Will be populated from payout method if available
        instructions: manualInstructions,
      };

      // If there's an associated name, add it
      if (settings.paymentMethods?.manual?.associatedName) {
        customProvider['associatedName'] = settings.paymentMethods.manual.associatedName;
      }

      // Initialize customPaymentProviders array if it doesn't exist
      const updatedSettings = {
        ...settings,
        customPaymentProviders: settings.customPaymentProviders || [],
      };

      // Only add if not already migrated (check by checking if instructions match)
      const alreadyMigrated = updatedSettings.customPaymentProviders.some(
        provider => provider.instructions === manualInstructions,
      );

      if (!alreadyMigrated) {
        updatedSettings.customPaymentProviders.push(customProvider);
      }

      // Update the collective's settings
      await queryInterface.sequelize.query(`UPDATE "Collectives" SET settings = :settings WHERE id = :id`, {
        replacements: {
          settings: JSON.stringify(updatedSettings),
          id: collective.id,
        },
      });
    }
  },

  async down(queryInterface) {
    // Remove customPaymentProviders that were migrated from manual instructions
    // This is a best-effort rollback - we can't perfectly restore the original state
    const [collectives] = await queryInterface.sequelize.query(`
      SELECT id, settings 
      FROM "Collectives" 
      WHERE settings -> 'customPaymentProviders' IS NOT NULL
    `);

    for (const collective of collectives) {
      const settings = collective.settings || {};
      const customProviders = settings.customPaymentProviders || [];

      if (customProviders.length === 0) {
        continue;
      }

      // Remove customPaymentProviders array if it only contains migrated entries
      // (We can't perfectly determine which were migrated, so we'll leave the array)
      const updatedSettings = {
        ...settings,
        customPaymentProviders: customProviders.filter(provider => {
          // Keep providers that don't look like migrated bank transfers
          // This is a heuristic - migrated ones typically have name "Bank Transfer"
          return provider.name !== 'Bank Transfer' || provider.accountDetails !== '';
        }),
      };

      // If array is empty, remove it
      if (updatedSettings.customPaymentProviders.length === 0) {
        delete updatedSettings.customPaymentProviders;
      }

      await queryInterface.sequelize.query(`UPDATE "Collectives" SET settings = :settings WHERE id = :id`, {
        replacements: {
          settings: JSON.stringify(updatedSettings),
          id: collective.id,
        },
      });
    }
  },
};
