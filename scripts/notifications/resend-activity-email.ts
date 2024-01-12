#!/usr/bin/env ./node_modules/.bin/babel-node

/**
 * A script to resend emails for activities.
 */

import '../../server/env';

import { Command } from 'commander';
import { difference, uniq } from 'lodash';

import { notifyByEmail } from '../../server/lib/notifications/email';
import models from '../../server/models';

const main = async () => {
  const program = new Command();
  program.argument('<activityIdList>', 'List of activity IDs to redispatch, separated by commas');
  program.option('--dry', 'Dry run');
  program.option('--force', 'Force notify, even if notify is set to false');
  program.option('--ignore-not-found', 'Ignore activities that are not found');
  program.parse();

  const options = program.opts();
  const rawActivityIdList = program.args[0];
  const activityIdList = uniq(rawActivityIdList.split(',').map(id => parseInt(id)));
  const activities = await models.Activity.findAll({ where: { id: activityIdList } });
  if (activities.length !== activityIdList.length) {
    const returnedIds = activities.map(a => a.id);
    const diff = difference(activityIdList, returnedIds);
    if (!options['ignoreNotFound']) {
      throw new Error(`Some activities were not found: ${diff.join(', ')}`);
    } else {
      console.warn(`Some activities were not found: ${diff.join(', ')}`);
    }
  }

  for (const activity of activities) {
    if (activity.data?.notify === false && !options.force) {
      console.log(`Skipping activity ${activity.id} (notify: false)`);
      continue;
    }

    if (options.dry) {
      console.log(`[Dry RUN] Dispatching activity ${activity.id}...`);
    } else {
      console.log(`Dispatching activity ${activity.id}...`);
      await notifyByEmail(activity);
    }
  }
};

main()
  .then(() => {
    console.log('Done');
    process.exit();
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
