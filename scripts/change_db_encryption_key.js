import { Command } from 'commander';
import config from 'config';
import cryptojs from 'crypto-js';

import { sequelize } from '../server/models';

const CIPHER = config.dbEncryption.cipher;
const SECRET_KEY = config.dbEncryption.secretKey;

/**
 * Change the DB encryption key by reencrypting the DB fields.
 *
 * @deprecated /!\ This script is not re-encrypting LegalDocuments data, and the lack of
 * pagination would probably make it crash in production. It needs to be updated to work
 * outside of dev environments.
 */
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
  if (!args.ignoreEnv && process.env.OC_ENV !== 'development') {
    console.error('This script is not ready to be run in production environment (see comment in the code)');
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
function parseCommandLineArguments() {
  const program = new Command()
    .description('Change DB Encryption keys by reencrypting the DB fields')
    .argument('<oldKey>', 'The current key being used')
    .argument('<newKey>', 'The new key you want to reencrypt data with')
    .option('--fromCipher <cipher>', 'The current cipher being used', CIPHER)
    .option('--toCipher <cipher>', 'The new cipher you want to reencrypt data with', CIPHER)
    .option('-f, --force', 'Ignore existing key check', false)
    .option('--ignore-env', 'Ignore the environment check', false)
    .parse(process.argv);

  const opts = program.opts();
  const [oldKey, newKey] = program.args;
  return {
    oldKey,
    newKey,
    fromCipher: opts.fromCipher,
    toCipher: opts.toCipher,
    force: opts.force,
    ignoreEnv: opts.ignoreEnv,
  };
}

if (!module.parent) {
  main(parseCommandLineArguments());
}
