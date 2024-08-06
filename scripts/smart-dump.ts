import '../server/env';

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cwd } from 'process';
import readline from 'readline';

import { Command } from 'commander';
import moment from 'moment';
import type { Sequelize } from 'sequelize';
import { Model as SequelizeModel, ModelStatic } from 'sequelize';

import { loaders } from '../server/graphql/loaders';
import { traverse } from '../server/lib/import-export/export';
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

  const tempDumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-export-'));
  logger.info(`>>> Temp directory: ${tempDumpDir}`);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { entries, defaultDependencies } = require(recipe);
  const parsed = {};
  const date = new Date().toISOString().substring(0, 10);
  const hash = md5(JSON.stringify({ entries, defaultDependencies, date })).slice(0, 5);
  const seenModelRecords: Set<string> = new Set();

  const gitRevision = execSync('git describe --always --abbrev=0 --match "NOT A TAG" --dirty="*"').toString().trim();
  fs.writeFileSync(
    `${tempDumpDir}/metadata.json`,
    JSON.stringify({
      gitRevision,
      date,
      asUser,
      hash,
      recipe: require(recipe),
    }),
  );

  let start = new Date();
  logger.info(`>>> Dumping... to ${tempDumpDir}/data.jsonl`);
  const dumpFile = fs.createWriteStream(`${tempDumpDir}/data.jsonl`);
  for (const entry of entries) {
    logger.info(`>>> Traversing DB for entry ${entries.indexOf(entry) + 1}/${entries.length}...`);
    await traverse({ ...entry, defaultDependencies, parsed }, req, async ei => {
      const modelRecordKey = `${ei.model}.${ei.id}`;
      if (!seenModelRecords.has(modelRecordKey)) {
        dumpFile.write(JSON.stringify(ei) + os.EOL);
        seenModelRecords.add(modelRecordKey);
      }
    });
  }
  dumpFile.close();
  logger.info(`>>> Dumped! ${seenModelRecords.size} records in ${moment(start).fromNow(true)}`);

  start = new Date();
  logger.info('>>> Dumping Schema...');
  exec(`pg_dump -csOx $PG_URL > ${tempDumpDir}/schema.sql`);
  logger.info(`>>> Schema Dumped! ${seenModelRecords.size} records in ${moment(start).fromNow(true)}`);

  logger.info(`>>> Ziping export to... dbdumps/${date}.${hash}.zip`);
  exec(`CUR_DIR=$PWD; cd ${tempDumpDir}; zip -r $CUR_DIR/dbdumps/${date}.${hash}.zip .; cd $CUR_DIR`);
  logger.info(`>>> Done! See dbdumps/${date}.${hash}.zip`);
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

  const importBundleAbsolutePath = path.resolve(cwd(), file);
  const tempImportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-import-'));
  logger.info(`>>> Temp directory: ${tempImportDir}`);
  exec(`CUR_DIR=$PWD; cd ${tempImportDir}; unzip ${importBundleAbsolutePath}; cd $CUR_DIR`);

  const importMetadata = JSON.parse(fs.readFileSync(path.join(tempImportDir, 'metadata.json')).toString());
  logger.info(
    `>>> Import metadata... date: ${importMetadata.date}, hash: ${importMetadata.hash}, gitRevision: ${importMetadata.gitRevision}`,
  );

  let start = new Date();
  logger.info('>>> Recreating DB...');
  exec(`dropdb ${database}`);
  exec(`createdb ${database}`);
  exec(`psql -h localhost -U postgres ${database} < ${tempImportDir}/schema.sql`);
  logger.info(`>>> DB Created! in ${moment(start).fromNow(true)}`);

  await sequelize.sync().catch(nop);

  const transaction = await (sequelize as Sequelize).transaction();

  const modelsArray: ModelStatic<SequelizeModel>[] = Object.values(models);
  let err;
  let count = 0;
  try {
    for (const model of modelsArray) {
      logger.info(`>>> Disabling triggers on table ${model.getTableName()}`);
      await sequelize.query(`ALTER TABLE "${model.getTableName()}" DISABLE TRIGGER ALL;`, { transaction });
    }

    logger.info(`>>> Opening file ${tempImportDir}/schema.sql`);
    const dataFile = path.join(tempImportDir, 'data.jsonl');
    const fileStream = fs.createReadStream(dataFile);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    start = new Date();
    logger.info('>>> Inserting Data...');

    for await (const line of rl) {
      const row = JSON.parse(line);
      const model: ModelStatic<SequelizeModel> = models[row.model];
      await model.create(row, {
        transaction,
        validate: false,
        hooks: false,
        silent: true,
        logging: false,
        raw: false,
        ignoreDuplicates: true,
      });
      count++;
    }
  } catch (e) {
    err = e;
  } finally {
    if (!err) {
      logger.info(`>>> Data inserted! ${count} records in ${moment(start).fromNow(true)}`);
      for (const model of modelsArray) {
        logger.info(`>>> Reenabling triggers on table ${model.getTableName()}`);
        await sequelize.query(`ALTER TABLE "${model.getTableName()}" ENABLE TRIGGER ALL;`, { transaction });
      }

      logger.info(`>>> Commiting transaction`);
      await transaction.commit();
    } else {
      console.error(err);
      logger.info(`>>> Rollback transaction`);
      transaction.rollback();
    }
  }

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
  $ PG_DATABASE=opencollective_prod_snapshot npm run script scripts/smart-dump.ts restore dbdumps/2023-03-21.c5292.zip
`,
);

program.parse();
