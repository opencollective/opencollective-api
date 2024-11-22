import '../server/env';

import { Command } from 'commander';
import config from 'config';

import models, { sequelize } from '../server/models';

const program = new Command();

program.addHelpText(
  'after',
  `

Example call:
  $ npm run script scripts/generate-jwt.ts id 1234
  $ npm run script scripts/generate-jwt.ts email willem@dafoe.com
`,
);

program.command('id <UserId> [env]').action(async id => {
  const user = await models.User.findByPk(id);

  if (!user) {
    console.error(`User with ID ${id} not found`);
    process.exit(1);
  }

  const jwt = await user.generateSessionToken({ createActivity: false, updateLastLoginAt: false });

  console.log(`localStorage.accessToken = '${jwt}'`);
  console.log(`${config.host.website}/signin/${jwt}`);

  sequelize.close();
});

program.command('email <email> [env]').action(async email => {
  const user = await models.User.findOne({ where: { email: email } });

  if (!user) {
    console.error(`User with email ${email} not found`);
    process.exit(1);
  }

  const jwt = await user.generateSessionToken({
    createActivity: false,
    updateLastLoginAt: false,
    expiration: 60 * 60 * 24,
  });

  console.log(`localStorage.accessToken = '${jwt}'`);
  console.log(`${config.host.website}/signin/${jwt}`);

  sequelize.close();
});

program.parse();
