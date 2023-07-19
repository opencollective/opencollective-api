#!/usr/bin/env node
import '../server/env.js';

import { ArgumentParser } from 'argparse';

import * as libdb from '../server/lib/db.js';

/** Help on how to use this script */
function usage() {
  console.error(`Usage: ${process.argv.join(' ')} <filename>.pgsql`);
  process.exit(1);
}

/** Return true if there's any data within the Collectives table */
async function hasData(client) {
  try {
    return (await client.query('SELECT 1 FROM "Collectives"')).rowCount > 0;
  } catch (error) {
    return false;
  }
}

/** Launcher that recreates a database & load a dump into it. */
export async function main(args) {
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
/* eslint-disable camelcase */
function parseCommandLineArguments() {
  const parser = new ArgumentParser({
    add_help: true,
    description: 'Restore dump file into a Database',
  });
  parser.add_argument('-q', '--quiet', {
    help: 'Silence output',
    default: true,
    action: 'store_const',
    const: false,
  });
  parser.add_argument('-f', '--force', {
    help: 'Overwrite existing database',
    default: false,
    action: 'store_const',
    const: true,
  });
  parser.add_argument('file', {
    help: 'Path for the dump file',
    action: 'store',
  });
  return parser.parse_args();
}
/* eslint-enable camelcase */

if (!module.parent) {
  main(parseCommandLineArguments());
}
