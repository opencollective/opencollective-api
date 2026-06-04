'use strict';

import type { QueryInterface } from 'sequelize';

const RENAME_UP_SQL = (table: string) => `
  UPDATE "${table}"
  SET data = data || jsonb_build_object('tax',
    (data->'tax')
      - 'taxIDNumber'
      - 'taxIDNumberFrom'
      || jsonb_strip_nulls(jsonb_build_object(
        'idNumber',     COALESCE(data->'tax'->>'idNumber',     data->'tax'->>'taxIDNumber'),
        'idNumberFrom', COALESCE(data->'tax'->>'idNumberFrom', data->'tax'->>'taxIDNumberFrom')
      ))
  )
  WHERE (data->'tax'->>'taxIDNumber' IS NOT NULL OR data->'tax'->>'taxIDNumberFrom' IS NOT NULL)
    AND "deletedAt" IS NULL
`;

const RENAME_DOWN_SQL = (table: string) => `
  UPDATE "${table}"
  SET data = data || jsonb_build_object('tax',
    (data->'tax')
      - 'idNumber'
      - 'idNumberFrom'
      || jsonb_strip_nulls(jsonb_build_object(
        'taxIDNumber',     data->'tax'->>'idNumber',
        'taxIDNumberFrom', data->'tax'->>'idNumberFrom'
      ))
  )
  WHERE (data->'tax'->>'idNumber' IS NOT NULL OR data->'tax'->>'idNumberFrom' IS NOT NULL)
    AND "deletedAt" IS NULL
`;

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    // Rename taxIDNumber -> idNumber and taxIDNumberFrom -> idNumberFrom in data.tax.
    // Existing idNumber / idNumberFrom values (written by newer code) take precedence.
    // Both Orders and Transactions store tax info in their data.tax field.
    await queryInterface.sequelize.query(RENAME_UP_SQL('Orders'));
    await queryInterface.sequelize.query(RENAME_UP_SQL('Transactions'));
  },

  async down(queryInterface: QueryInterface) {
    // Rename idNumber -> taxIDNumber and idNumberFrom -> taxIDNumberFrom in data.tax.
    await queryInterface.sequelize.query(RENAME_DOWN_SQL('Orders'));
    await queryInterface.sequelize.query(RENAME_DOWN_SQL('Transactions'));
  },
};
