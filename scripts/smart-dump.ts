import '../server/env';

import { execSync } from 'child_process';

import { Command } from 'commander';
import { readJsonSync, writeJsonSync } from 'fs-extra';
import { uniqBy } from 'lodash';
import moment from 'moment';

import { loaders } from '../server/graphql/loaders';
import { traverse } from '../server/lib/import-export/export';
import { restoreRows } from '../server/lib/import-export/import';
import { PartialRequest } from '../server/lib/import-export/types';
import logger from '../server/lib/logger';
import { md5 } from '../server/lib/utils';
import models, { sequelize } from '../server/models';

const program = new Command();
const nop = () => undefined;
const exec = cmd => {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (e) {
    logger.error(e);
  }
};

program.command('dump [recipe] [env] [as_user]').action(async (recipe, env, asUser) => {
  if (!sequelize.config.username.includes('readonly')) {
    logger.error('Remote must be connected with read-only user!');
    process.exit(1);
  } else if (!asUser) {
    logger.error('as_user is required');
    process.exit(1);
  }

  if (!recipe || (recipe && !env)) {
    logger.info('Using default recipe...');
    recipe = './smart-dump/defaultRecipe.js';
  }

  // Prepare req object
  const remoteUser = await models.User.findOne({ include: [{ association: 'collective', where: { slug: asUser } }] });
  const req: PartialRequest = { remoteUser, loaders: loaders({ remoteUser }) };

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { entries, defaultDependencies } = require(recipe);
  const parsed = {};
  const date = new Date().toISOString().substring(0, 10);
  const hash = md5(JSON.stringify({ entries, defaultDependencies, date })).slice(0, 5);
  const filename = `${date}.${hash}`;
  let docs = [];

  let start = new Date();
  logger.info('>>> Dumping...');
  for (const entry of entries) {
    logger.info(`>>> Traversing DB for entry ${entries.indexOf(entry) + 1}/${entries.length}...`);
    const newdocs = await traverse({ ...entry, defaultDependencies, parsed, req });
    docs.push(...newdocs);
  }
  logger.info(`>>> Dumped! ${docs.length} records in ${moment(start).fromNow(true)}`);

  logger.info('>>> Deduplicating...');
  docs = uniqBy(docs, r => `${r.model}.${r.id}`);

  start = new Date();
  logger.info('>>> Writting JSON...');
  writeJsonSync(`dbdumps/${filename}.json`, docs, { spaces: 2 });
  logger.info(`>>> Written! in ${moment(start).fromNow(true)}`);

  start = new Date();
  logger.info('>>> Dumping Schema...');
  exec(`pg_dump -csOx $PG_URL > dbdumps/${filename}.schema.sql`);
  logger.info(`>>> Schema Dumped! ${docs.length} records in ${moment(start).fromNow(true)}`);

  logger.info(`>>> Done! See dbdumps/${filename}.json and dbdumps/${filename}.schema.sql`);
  sequelize.close();
});

program.command('restore <file>').action(async file => {
  const database = process.env.PG_DATABASE;
  if (!database) {
    logger.error('PG_DATABASE is not set!');
    process.exit(1);
  } else if (sequelize.config.database !== database) {
    logger.error(`Sequelize is not connected to target ${database}!`);
    process.exit(1);
  }

  let start = new Date();
  logger.info('>>> Recreating DB...');
  exec(`dropdb ${database}`);
  exec(`createdb ${database}`);
  exec(`psql -h localhost -U opencollective ${database} < ${file.replace('.json', '.schema.sql')}`);
  logger.info(`>>> DB Created! in ${moment(start).fromNow(true)}`);

  await sequelize.sync().catch(nop);

  logger.info(`>>> Reading file ${file}`);
  const docs = readJsonSync(file);

  start = new Date();
  logger.info('>>> Inserting Data...');
  const modelsArray: any[] = Object.values(models);
  for (const model of modelsArray) {
    const rows = docs.filter(d => d.model === model.name);
    if (rows.length > 0) {
      try {
        await restoreRows(model, rows);
      } catch (e) {
        logger.error(e);
      }
    }
  }
  logger.info(`>>> Data inserted! in ${moment(start).fromNow(true)}`);

  logger.info('>>> Refreshing Materialized Views...');
  await sequelize.query(`REFRESH MATERIALIZED VIEW "TransactionBalances"`);
  await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveBalanceCheckpoint"`);
  await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
  await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTagStats"`);
  await sequelize.query(`REFRESH MATERIALIZED VIEW "ExpenseTagStats"`);
  await sequelize.query(`REFRESH MATERIALIZED VIEW "HostMonthlyTransactions"`);

  logger.info('>>> Done!');
  sequelize.close();
});

program.addHelpText(
  'after',
  `

Example call:
  $ npm run script scripts/smart-dump.ts dump prod superuser
  $ PG_DATABASE=opencollective_prod_snapshot npm run script scripts/smart-dump.ts restore dbdumps/2023-03-21.c5292.json
`,
);

program.parse();
