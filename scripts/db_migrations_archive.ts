import '../server/env';

import { execSync } from 'child_process';
import fs from 'fs';

import { Command } from 'commander';
import moment from 'moment';

import { confirm } from './common/helpers';

const options = new Command()
  .description('Helper to archive old migrations')
  .requiredOption('--until <date>', 'Archive all migrations until this date', value => moment(value))
  .parse()
  .opts();

const getMovedFilesList = (until: moment.Moment): string[] => {
  const files = fs.readdirSync('migrations');
  return files.filter(file => moment(file.split('-')[0], 'YYYYMMDDHHmmss') < until).sort();
};

// Main
(async function () {
  // Print a confirmation before starting the script
  const movedFiles = getMovedFilesList(options.until);
  if (movedFiles.length === 0) {
    console.log('No migrations to archive');
    process.exit(0);
  }

  movedFiles.forEach(file => console.log(`- ${file}`));
  if (!(await confirm('You are about to archive the migrations listed above. Are you sure you want to continue?'))) {
    process.exit(0);
  }

  // Step 1: run migrations to make sure we're up to date
  console.log('Running migrations to make sure local DB is up to date...');
  try {
    execSync('pnpm db:migrate', { stdio: 'inherit' });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }

  // Step 2: Dump database
  try {
    execSync('pnpm db:dump:dev', { stdio: 'inherit' });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }

  // Step 3: move old migrations to `archives` folder
  for (const file of movedFiles) {
    fs.renameSync(`migrations/${file}`, `migrations/archives/${file}`);
  }

  console.log('Done!');
  process.exit(0);
})();
