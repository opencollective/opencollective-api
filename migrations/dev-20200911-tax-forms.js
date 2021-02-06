'use strict';

/**
 * Add a required tax for on Open Source host (opensourceorg) to make it easier to test in dev.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
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

  down: async () => {},
};
