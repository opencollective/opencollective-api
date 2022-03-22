'use strict';

import { omit } from 'lodash';

import { crypto } from '../server/lib/encryption';

async function renameFieldInVirtualCardsPrivateData(queryInterface, from, to) {
  const [virtualCards] = await queryInterface.sequelize.query(
    `SELECT "id", "privateData" FROM "VirtualCards" WHERE "privateData" IS NOT NULL;`,
  );
  console.info(`Renaming '${from}' to '${to}' for ${virtualCards.length} VirtualCards...`);
  try {
    await queryInterface.sequelize.transaction(async transaction => {
      for (const virtualCard of virtualCards) {
        const originalPrivateData = JSON.parse(crypto.decrypt(virtualCard.privateData));
        if (!(from in originalPrivateData)) {
          console.debug(`'${from}' not in 'privateData' for VirtualCard with id=${virtualCard.id}`);
          continue;
        }
        const privateData = {
          ...omit(originalPrivateData, [from]),
        };
        privateData[to] = originalPrivateData[from];
        const encryptedPrivateData = JSON.stringify(crypto.encrypt(privateData));
        console.debug(`Renaming '${from}' to '${to}' for VirtualCard with id=${virtualCard.id}`);
        await queryInterface.sequelize.query(
          `
            UPDATE "VirtualCards"
            SET "privateData" = :privateData
            WHERE "id" = :id;
          `,
          {
            transaction,
            replacements: {
              encryptedPrivateData,
              id: virtualCard.id,
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
}

module.exports = {
  async up(queryInterface) {
    renameFieldInVirtualCardsPrivateData(queryInterface, 'expireDate', 'expiryDate');
  },

  async down(queryInterface) {
    renameFieldInVirtualCardsPrivateData(queryInterface, 'expiryDate', 'expireDate');
  },
};
