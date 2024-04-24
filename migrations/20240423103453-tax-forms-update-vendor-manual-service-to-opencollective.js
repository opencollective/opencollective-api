'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "LegalDocuments"
      SET
        service = 'OPENCOLLECTIVE',
        "data" = JSONB_SET(COALESCE("data", '{}'), '{isManual}', 'true'::JSONB)
      WHERE "requestStatus" = 'RECEIVED'
      AND (
        "documentLink" IS NULL
        OR (
          "documentLink" NOT ILIKE 'https://opencollective-production-us-tax-forms.s3.us-west-1.amazonaws.com/%'
          AND "documentLink" NOT ILIKE 'https://opencollective-production-us-tax-forms.s3-us-west-1.amazonaws.com/%'
        )
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "LegalDocuments"
      SET service = 'DROPBOX_FORMS'
      WHERE "requestStatus" = 'RECEIVED'
      AND (
        "documentLink" IS NULL
        OR (
          "documentLink" NOT ILIKE 'https://vendor.opencollective.com/api/v1/collectives/%/legal-documents/%'
          AND "documentLink" NOT ILIKE 'https://vendor.opencollective.com/api/v1/collectives/%/legal-documents/%'
        )
      );
    `);
  },
};
