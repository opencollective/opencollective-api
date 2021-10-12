'use strict';

/**
 * Add a required tax for on Open Source host (opensourceorg) to make it easier to test in dev.
 */
module.exports = {
  up: async queryInterface => {
    const scriptName = 'dev-20200911-tax-forms.js';
    const [, result] = await queryInterface.sequelize.query(`
      SELECT name from "SequelizeMeta" WHERE name='${scriptName}';
    `);

    if (result.rowCount === 1) {
      console.info(`Skipping execution of script as it's already executed: ${scriptName}`);
      return;
    }

    if (process.env.NODE_ENV === undefined || process.env.NODE_ENV === 'development') {
      return queryInterface.sequelize.query(`
        INSERT INTO "RequiredLegalDocuments" (
          "documentType",
          "createdAt",
          "updatedAt",
          "HostCollectiveId"
        ) VALUES (
          'US_TAX_FORM',
          NOW(),
          NOW(),
          9805 -- Open Source (opensourceorg)
        )
      `);
    }
  },

  down: async () => {
    // No rollback
  },
};
