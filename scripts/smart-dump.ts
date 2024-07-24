import '../server/env';

import { execSync } from 'child_process';

import { Command } from 'commander';
import { readJsonSync, writeJsonSync } from 'fs-extra';
import { uniqBy } from 'lodash';

import { traverse } from '../server/lib/export';
import { md5 } from '../server/lib/utils';
import models, { sequelize } from '../server/models';

const program = new Command();
const nop = () => undefined;
const exec = cmd => {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (e) {
    console.error(e);
  }
};

program.command('dump [recipe] [env]').action(async (recipe, env) => {
  if (!sequelize.config.username.includes('readonly')) {
    console.error('Remote must be connected with read-only user!');
    process.exit(1);
  }

  if (!recipe || (recipe && !env)) {
    console.log('Using default recipe...');
    recipe = './smart-dump/defaultRecipe.js';
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { entries, defaultDependencies } = require(recipe);
  const parsed = {};
  const date = new Date().toISOString().substring(0, 10);
  const hash = md5(JSON.stringify({ entries, defaultDependencies, date })).slice(0, 5);
  const filename = `${date}.${hash}`;
  let docs = [];
  console.time('>>> Dump');
  for (const entry of entries) {
    console.log(`\n>>> Traversing DB for entry ${entries.indexOf(entry) + 1}/${entries.length}...`);
    const newdocs = await traverse({ ...entry, defaultDependencies, parsed });
    docs.push(...newdocs);
  }
  console.timeEnd('>>> Dump');

  console.log('\n>>> Deduplicating...');
  docs = uniqBy(docs, r => `${r.model}.${r.id}`);

  console.log('\n>>> Dumping JSON...');
  writeJsonSync(`dbdumps/${filename}.json`, docs, { spaces: 2 });

  console.log('\n>>> Dumping Schema...');
  exec(`pg_dump -csOx $PG_URL > dbdumps/${filename}.schema.sql`);

  console.log(`\n>>> Done! Dumped to dbdumps/${filename}.json`);
  sequelize.close();
});

program.command('restore <file>').action(async file => {
  const database = process.env.PG_DATABASE;
  if (!database) {
    console.error('PG_DATABASE is not set!');
    process.exit(1);
  } else if (sequelize.config.database !== database) {
    console.error(`Sequelize is not connected to target ${database}!`);
    process.exit(1);
  }

  console.log('\n>>> Recreating DB...');
  exec(`dropdb ${database}`);
  exec(`createdb ${database}`);
  exec(`psql -h localhost -U opencollective ${database} < ${file.replace('.json', '.schema.sql')}`);

  await sequelize.sync().catch(nop);

  console.log(`\n>>> Reading file ${file}`);
  const docs = readJsonSync(file);

  console.log('\n>>> Inserting Data...');
  const modelsArray: any[] = Object.values(models);
  for (const model of modelsArray) {
    const rows = docs.filter(d => d.model === model.name);
    if (rows.length > 0) {
      console.log(`\t${model.name} (${rows.length} rows)`);
      await sequelize
        .transaction(async transaction => {
          const tablename = model.getTableName();
          await sequelize.query(`ALTER TABLE "${tablename}" DISABLE TRIGGER ALL;`, { transaction });
          for (const row of rows) {
            await model
              .create(row, {
                transaction,
                validate: false,
                hooks: false,
                silent: true,
                logging: false,
                raw: false,
                ignoreDuplicates: true,
              })
              .catch(console.error);
          }
          await sequelize.query(`ALTER TABLE "${tablename}" ENABLE TRIGGER ALL;`, { transaction });
        })
        .catch(e => {
          console.error(e);
        });
    }
  }

  console.log('\n>>> Refreshing Materialized Views...');
  await sequelize.query(`REFRESH MATERIALIZED VIEW "TransactionBalances"`);
  await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveBalanceCheckpoint"`);
  await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
  await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTagStats"`);
  await sequelize.query(`REFRESH MATERIALIZED VIEW "ExpenseTagStats"`);
  await sequelize.query(`REFRESH MATERIALIZED VIEW "HostMonthlyTransactions"`);

  console.log('\n>>> Done!');
  sequelize.close();
});

program.addHelpText(
  'after',
  `

Example call:
  $ npm run script scripts/smart-dump.ts dump prod
  $ PG_DATABASE=opencollective_prod_snapshot npm run script scripts/smart-dump.ts restore dbdumps/2023-03-21.c5292.json
`,
);

program.parse();
