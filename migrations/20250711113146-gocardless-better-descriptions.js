'use strict';

const { truncate, trim } = require('lodash');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const rows = await queryInterface.sequelize.query(
      `
      SELECT tr.id, tr.description, tr."rawValue"
      FROM "TransactionsImportsRows" tr
      INNER JOIN "TransactionsImports" ti ON tr."TransactionsImportId" = ti.id
      WHERE ti.type = 'GOCARDLESS'
    `,
      {
        type: Sequelize.QueryTypes.SELECT,
      },
    );

    const formatDescription = description => {
      return truncate(trim(description.replace(/\s+/g, ' ')), { length: 255 });
    };

    for (const row of rows) {
      const description =
        row.rawValue.remittanceInformationStructured ||
        row.rawValue.remittanceInformationUnstructured ||
        row.rawValue.remittanceInformationUnstructuredArray.join(', ') ||
        row.description;

      await queryInterface.sequelize.query(
        `UPDATE "TransactionsImportsRows" SET "description" = :description WHERE id = :id`,
        {
          type: Sequelize.QueryTypes.UPDATE,
          replacements: {
            description: formatDescription(description),
            id: row.id,
          },
        },
      );
    }
  },

  async down() {
    console.log('This migration is irreversible');
  },
};
