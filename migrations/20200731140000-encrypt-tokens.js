'use strict';

import { crypto } from '../server/lib/encryption';

module.exports = {
  up: async queryInterface => {
    const [accounts] = await queryInterface.sequelize.query(
      `SELECT "id", "service", "token", "refreshToken" FROM "ConnectedAccounts" WHERE "hash" IS NULL;`,
    );
    console.info(`Encrypting ${accounts.length} ConnectedAccounts...`);
    try {
      const result = await queryInterface.sequelize.transaction(async transaction => {
        for (const account of accounts) {
          const hash = crypto.hash(account.service + account.token);
          const token = crypto.encrypt(account.token);
          const refreshToken = crypto.encrypt(account.refreshToken);
          await queryInterface.sequelize.query(
            `
            UPDATE "ConnectedAccounts"
            SET "hash" = :hash, "token" = :token, "refreshToken" = :refreshToken
            WHERE "id" = :id;
          `,
            {
              transaction,
              replacements: {
                hash,
                token,
                refreshToken,
                id: account.id,
              },
            },
          );
        }
      });
      console.info('Done.');
    } catch (e) {
      console.error('Oops, something went wrong and I rolled back the transaction.');
      console.error(e);
    }
  },

  down: async queryInterface => {
    const [accounts] = await queryInterface.sequelize.query(
      `SELECT "id", "service", "token", "refreshToken" FROM "ConnectedAccounts" WHERE "hash" IS NOT NULL;`,
    );
    console.info(`Decrypting ${accounts.length} ConnectedAccounts...`);
    try {
      const result = await queryInterface.sequelize.transaction(async transaction => {
        for (const account of accounts) {
          const token = crypto.decrypt(account.token);
          const refreshToken = crypto.decrypt(account.refreshToken);
          await queryInterface.sequelize.query(
            `
            UPDATE "ConnectedAccounts"
            SET "token" = :token, "refreshToken" = :refreshToken, "hash" = NULL
            WHERE "id" = :id;
          `,
            {
              transaction,
              replacements: {
                token,
                refreshToken,
                id: account.id,
              },
            },
          );
        }
      });
      console.info('Done.');
    } catch (e) {
      console.error('Oops, something went wrong and I rolled back the transaction.');
      console.error(e);
    }
  },
};
