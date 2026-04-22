'use strict';

import { updateEnum } from './lib/helpers';

const previousScopes = [
  'email',
  'incognito',
  'account',
  'expenses',
  'orders',
  'transactions',
  'virtualCards',
  'updates',
  'conversations',
  'webhooks',
  'host',
  'applications',
  'connectedAccounts',
  'root',
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_PersonalTokens_scope"
      ADD VALUE IF NOT EXISTS 'kyc'
    `);
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_PersonalTokens_scope"
      ADD VALUE IF NOT EXISTS 'exportRequests'
    `);
  },

  async down(queryInterface) {
    await updateEnum(queryInterface, 'PersonalTokens', 'scope', 'enum_PersonalTokens_scope', previousScopes);
  },
};
