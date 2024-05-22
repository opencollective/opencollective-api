import { ArgumentParser } from 'argparse';
import config from 'config';
import cryptojs from 'crypto-js';

import { sequelize } from '../server/models';

const CIPHER = config.dbEncryption.cipher;
const SECRET_KEY = config.dbEncryption.secretKey;

async function main(args) {
  if (!args.oldKey || !args.newKey) {
    console.error('You need to provide both old and new key.');
    console.error(
      `Usage: npm run script scripts/change_db_encryption_key.js -- [-f] [--fromCipher DES] [--toCipher DES] oldKey newKey`,
    );
    process.exit(1);
  }
  if (!args.force && SECRET_KEY && args.oldKey !== SECRET_KEY) {
    console.error('Your oldKey does not match the existing DB_ENCRYPTION_SECRET_KEY!');
    process.exit(1);
  }
  console.log(`Re-encrypting from cipher ${args.fromCipher} to cipher ${args.toCipher}...`);

  const [accounts] = await sequelize.query(
    `SELECT "id", "service", "token", "refreshToken" FROM "ConnectedAccounts" WHERE "token" IS NOT NULL`,
  );

  console.info(`Re-encrypting ${accounts.length} ConnectedAccounts...`);
  const encrypt = message => cryptojs[args.toCipher].encrypt(message, args.newKey).toString();
  const decrypt = encryptedMessage =>
    cryptojs[args.fromCipher].decrypt(encryptedMessage, args.oldKey).toString(cryptojs.enc.Utf8);

  try {
    await sequelize.transaction(async transaction => {
      for (const account of accounts) {
        const token = decrypt(account.token);
        const refreshToken = decrypt(account.refreshToken);
        await sequelize.query(
          `
          UPDATE "ConnectedAccounts"
          SET "token" = :token, "refreshToken" = :refreshToken
          WHERE "id" = :id;
        `,
          {
            transaction,
            replacements: {
              token: encrypt(token),
              refreshToken: encrypt(refreshToken),
              id: account.id,
            },
          },
        );
      }
    });
  } catch (e) {
    console.error('Oops, something went wrong and I rolled back the transaction.');
    console.error(e);
  }
  console.log('Done!');
  process.exit(0);
}

/** Return the options passed by the user to run the script */
/* eslint-disable camelcase */
function parseCommandLineArguments() {
  const parser = new ArgumentParser({
    addHelp: true,
    description: 'Change DB Encryption keys by reencrypting the DB fields',
  });
  parser.add_argument('--fromCipher', {
    help: 'The current cipher being used',
    default: CIPHER,
  });
  parser.add_argument('--toCipher', {
    help: 'The new cipher you wantt o reencrypt data with',
    default: CIPHER,
  });
  parser.add_argument('-f', '--force', {
    help: 'Ignore existing key check',
    default: false,
    action: 'store_const',
    const: true,
  });
  parser.add_argument('oldKey', {
    help: 'The current key being used',
    action: 'store',
  });
  parser.add_argument('newKey', {
    help: 'The new key you want to reencrypt data with',
    action: 'store',
  });
  return parser.parse_args();
}
/* eslint-enable camelcase */

if (!module.parent) {
  main(parseCommandLineArguments());
}
