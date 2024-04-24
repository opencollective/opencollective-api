'use strict';

import { updateEnum } from './lib/helpers';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_LegalDocuments_requestStatus"
      ADD VALUE IF NOT EXISTS 'INVALID'
    `);
  },

  async down(queryInterface) {
    await updateEnum(
      queryInterface,
      'LegalDocuments',
      'requestStatus',
      'enum_LegalDocuments_requestStatus',
      ['NOT_REQUESTED', 'REQUESTED', 'RECEIVED', 'ERROR'],
      { isArray: false },
    );
  },
};
