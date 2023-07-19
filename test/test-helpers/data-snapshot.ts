import url from 'url';
const __dirname = url.fileURLToPath(new url.URL('.', import.meta.url));
/**
 * A set of helpers for creating database snapshots and restoring them, intended to save time in
 * tests that need to setup a lot of data to test against.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';

import config from 'config';
import slugify from 'limax';
import { Context } from 'mocha';

import { getDBConf } from '../../server/lib/db.js';
import logger from '../../server/lib/logger.js';
import { parseToBoolean } from '../../server/lib/utils.js';
import { sequelize } from '../../server/models/index.js';

const snapshotCurrentDB = (filePath: string) => {
  // Create base directory if it doesn't exist
  const baseDir = path.dirname(filePath);
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  // Run pg_dump
  const { database, username, password, host, port } = getDBConf('database');
  const cmd = `pg_dump -Fc -Z9 "postgres://${username}:${password}@${host}:${port}/${database}" > "${filePath}"`;
  execSync(cmd, { stdio: 'inherit' });
};

const restoreDBSnapshot = (filePath: string) => {
  const { database, username, password, host, port } = getDBConf('database');
  const cmd = `pg_restore --clean --exit-on-error --schema public -d "postgres://${username}:${password}@${host}:${port}/${database}" "${filePath}"`;
  execSync(cmd, { stdio: 'inherit' });
};

const getNumberOfPendingMigrations = async () => {
  const latestMigrationInDb = await sequelize.query(`SELECT name FROM "SequelizeMeta" ORDER BY name DESC LIMIT 1;`, {
    type: sequelize.QueryTypes.SELECT,
    raw: true,
  });

  const latestMigrationName = latestMigrationInDb[0].name; // Will get something like 20230306125514-add-transaction-type-createdAt-index.js

  // List files in migrations folder
  const migrationsFolder = path.join(__dirname, '../../migrations');
  const files = readdirSync(migrationsFolder);
  const migrations = files.filter(file => file.match(/^[0-9]{14}-.*\.(js|ts)$/)).sort();
  const indexOfLatestMigration = migrations.indexOf(latestMigrationName);
  const notRunMigrations = migrations.slice(indexOfLatestMigration + 1);
  return notRunMigrations.length;
};

const runMigrations = (snapshotPath, { warnIfTooSlow = false } = {}) => {
  const start = Date.now();
  execSync('npm run db:migrate', { stdio: 'inherit' });
  const end = Date.now();
  const duration = end - start;

  if (warnIfTooSlow) {
    if (duration > 15000) {
      throw new Error(
        `[TEST] Migrating ${snapshotPath} after restore took ${duration}ms. Consider updating the snapshots with 'npm run test:update-db-snapshots`,
      );
    } else if (duration > 10000) {
      logger.warn(
        `[TEST] Migrating ${snapshotPath} after restore took ${duration}ms. Consider updating the snapshots with 'npm run test:update-db-snapshots`,
      );
    } else if (duration > 5000) {
      logger.info(
        `[TEST] Migrating ${snapshotPath} after restore took ${duration}ms. Consider updating the snapshots with 'npm run test:update-db-snapshots`,
      );
    }
  }
};

/**
 * This function is worth using if your test initialization takes more than 15 seconds.
 *
 * @param testContext The Mocha test context. Used to adjust the timeout.
 * @param snapshotName A unique name for the snapshot. This is used to identify the snapshot in the database.
 * @param initializer A function that will be called to initialize the snapshot if it doesn't exist.
 */
export const getOrCreateDBSnapshot = async (
  testContext: Context,
  snapshotName: string,
  initializer: () => Promise<void>,
) => {
  const snapshotPath = path.join(__dirname, `../dbdumps/snapshots/${slugify(snapshotName)}.pgdump`);
  const forceSnapshotUpdate = parseToBoolean(process.env.UPDATE_DB_SNAPSHOTS);
  if (forceSnapshotUpdate || !existsSync(snapshotPath)) {
    if (config.env === 'ci') {
      throw new Error(
        `[TEST] Snapshot ${snapshotPath} does not exists. Please run 'npm run test:update-db-snapshots' on your local machine to generate it.`,
      );
    }

    const start = Date.now();
    const previousTimeout = testContext.timeout();
    testContext.timeout(120000); // Allow 2 minutes for initializing the DB
    runMigrations(snapshotPath); // Run migrations to make sure test DB is up to date
    await initializer(); // Run custom initializer to prepare the data
    snapshotCurrentDB(snapshotPath); // Create snapshot
    const end = Date.now();
    const duration = end - start;
    testContext.timeout(previousTimeout + duration); // Restore previous timeout but add the time we already spend, otherwise it will expire right after setting the value
  } else {
    logger.info(`[TEST] Creating snapshot at ${snapshotPath}`);
    restoreDBSnapshot(snapshotPath);
    const numberOfPendingMigrations = await getNumberOfPendingMigrations();
    if (numberOfPendingMigrations > 0) {
      runMigrations(snapshotPath, { warnIfTooSlow: true });
    }
  }
};
