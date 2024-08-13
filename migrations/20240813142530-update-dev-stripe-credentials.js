'use strict';

import { crypto } from '../server/lib/encryption';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `
        UPDATE "ConnectedAccounts"
        SET
          "username" = 'acct_17GUlBGSh14qHxZK', 
          "token" = :newToken,
          "refreshToken" = NULL,
          "data" = JSONB_SET(COALESCE("data", '{}'), '{publishableKey}', '"pk_test_gwOTnKFLVpiYhsbXXfZcLPtR"'::JSONB),
          "updatedAt" = NOW()
        WHERE "username" = 'acct_18KWlTLzdXg9xKNS'
        AND "deletedAt" IS NULL 
    `,
      {
        replacements: {
          newToken: crypto.encrypt('sk_test_DVhbUwvSoAvDfjlTRE0IrSPs'),
        },
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `
        UPDATE "ConnectedAccounts"
        SET
          "username" = 'acct_18KWlTLzdXg9xKNS',
          "token" = :oldToken,
          "refreshToken" = NULL,
          "data" = JSONB_SET(COALESCE("data", '{}'), '{publishableKey}', '"pk_test_l7H1cDlh2AekeETfq742VJbC"'::JSONB),
          "updatedAt" = NOW()
        WHERE "username" = 'acct_17GUlBGSh14qHxZK'
        AND "deletedAt" IS NULL
    `,
      {
        replacements: {
          oldToken: crypto.encrypt('sk_test_iDWQubtz4ixk0FQg1csgCi6p'),
        },
      },
    );
  },
};
