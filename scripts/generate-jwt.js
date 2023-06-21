import '../server/env';

import { ArgumentParser } from 'argparse';
import config from 'config';
import moment from 'moment';

import models from '../server/models';

/** Help on how to use this script */
function usage() {
  console.error(`Usage: ${process.argv.join(' ')} <UserID>`);
  process.exit(1);
}

// Helper
const daysToSeconds = days => moment.duration({ days }).asSeconds();

// export const JWT_TOKEN_EXPIRATION = daysToSeconds(90);
export const JWT_TOKEN_EXPIRATION = daysToSeconds(1);

async function main(args) {
  if (!args.user_id) {
    usage();
    return;
  }

  const user = await models.User.findByPk(args.user_id);

  const jwt = await user.generateSessionToken({ createActivity: false, updateLastLoginAt: false });

  console.log(`${config.host.website}/signin/${jwt}`);
}

/** Return the options passed by the user to run the script */
function parseCommandLineArguments() {
  const parser = new ArgumentParser({
    add_help: true, // eslint-disable-line camelcase
    description: 'Create a JWT Token',
  });
  parser.add_argument('user_id', {
    help: 'Internal User ID in the database',
    action: 'store',
  });
  return parser.parse_args();
}

main(parseCommandLineArguments());
