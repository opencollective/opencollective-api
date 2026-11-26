import '../server/env';

import { Command } from 'commander';
import type pg from 'pg';

import * as libdb from '../server/lib/db';

/** Options passed by the user to run the script */
type ScriptArgs = {
  file?: string;
  quiet?: boolean;
  force: boolean;
};

/** Help on how to use this script */
function usage() {
  console.error(`Usage: ${process.argv.join(' ')} <filename>.pgsql`);
  process.exit(1);
}

/** Return true if there's any data within the Collectives table */
async function hasData(client: pg.Client): Promise<boolean> {
  try {
    return (await client.query('SELECT 1 FROM "Collectives"')).rowCount > 0;
  } catch {
    return false;
  }
}

/** Launcher that recreates a database & load a dump into it. */
export async function main(args: ScriptArgs): Promise<void> {
  if (!args.file) {
    usage();
    return;
  }

  const [client, clientApp] = await libdb.recreateDatabase(args.force);

  const data = await hasData(clientApp);

  if (!data || (data && args.force)) {
    await libdb.loadDB(args.file);
  }

  await Promise.all([client.end(), clientApp.end()]);
}

/** Return the options passed by the user to run the script */
function parseCommandLineArguments(): ScriptArgs {
  const program = new Command()
    .description('Restore dump file into a Database')
    .argument('<file>', 'Path for the dump file')
    .option('-q, --quiet', 'Silence output', false)
    .option('-f, --force', 'Overwrite existing database', false)
    .parse(process.argv);

  const opts = program.opts();
  return {
    file: program.args[0],
    quiet: opts.quiet,
    force: opts.force,
  };
}

if (!module.parent) {
  main(parseCommandLineArguments());
}
