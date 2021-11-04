'use strict';

import { hasCompletedMigration, removeMigration } from './lib/helpers';
module.exports = {
  up: async queryInterface => {
    // Migration was renamed
    const scriptName = 'dev-20211012-remove-givingblock-info-from-custom-order-data.js';
    if (await hasCompletedMigration(queryInterface, scriptName)) {
      console.info(`Skipping execution of script as it's already executed: ${scriptName}`);
      await removeMigration(queryInterface, scriptName);
      return;
    }

    await queryInterface.sequelize.query(`
      UPDATE "Orders"
      SET data = jsonb_set("data", '{thegivingblock}', jsonb_build_object('pledgeAmount', data -> 'customData' ->> 'pledgeAmount', 'pledgeCurrency', data -> 'customData' ->> 'pledgeCurrency'), TRUE)
        #- '{customData, pledgeAmount}'
        #- '{customData, pledgeCurrency}'
      WHERE "data" -> 'customData' ->> 'pledgeAmount' IS NOT NULL
        AND "data" -> 'customData' ->> 'pledgeCurrency' IS NOT NULL;
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Orders"
      SET data = jsonb_set("data", '{customData}', "data" -> 'thegivingblock', TRUE)
        #- '{thegivingblock, pledgeAmount}'
        #- '{thegivingblock, pledgeCurrency}'
      WHERE "data" -> 'thegivingblock' ->> 'pledgeAmount' IS NOT NULL
        AND "data" -> 'thegivingblock' ->> 'pledgeCurrency' IS NOT NULL;
    `);
  },
};
