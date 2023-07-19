#!/usr/bin/env node
import '../server/env.js';

import { ArgumentParser } from 'argparse';

import status from '../server/constants/order_status.js';
import { PLANS_COLLECTIVE_SLUG } from '../server/constants/plans.js';
import models, { Op } from '../server/models/index.js';

async function run({ dryRun } = {}) {
  const hosts = await models.Collective.findAll({
    where: {
      isHostAccount: { [Op.is]: true },
    },
  });

  const previousPlansSlugs = ['single-host-plan', 'small-host-plan', 'medium-host-plan', 'large-host-plan'];

  for (const host of hosts) {
    console.log(`Checking ${host.slug}`);
    if (!host.isActive && host.plan === 'grow-plan-2021') {
      console.log(`- Activating Budget`);
      if (!dryRun) {
        await host.activateBudget();
      }
    }

    if (host.hostFeePercent && host.plan === 'start-plan-2021') {
      console.log(`- Updating Host Fee`);
      if (!dryRun) {
        // This will NOT cascade to all Collectives
        await host.update({ hostFeePercent: 0 });
      }
    }

    if (host.platformFeePercent && (host.plan === 'start-plan-2021' || host.plan === 'grow-plan-2021')) {
      console.log(`- Updating Platform Fee`);
      if (!dryRun) {
        // This will NOT cascade to all Collectives
        await host.update({ platformFeePercent: 0 });
      }
    }

    if (host.plan === 'start-plan-2021' || host.plan === 'grow-plan-2021') {
      const order = await models.Order.findOne({
        where: { status: status.ACTIVE },
        include: [
          { model: models.Collective, as: 'collective', where: { slug: PLANS_COLLECTIVE_SLUG } },
          { model: models.Collective, as: 'fromCollective', where: { id: host.id } },
          { model: models.Subscription, as: 'Subscription' },
          { model: models.Tier, as: 'Tier', where: { slug: { [Op.in]: previousPlansSlugs } } },
        ],
        order: [['updatedAt', 'DESC']],
      });
      if (order) {
        console.log(`- Cancelling previous Plan`);
      }
      if (!dryRun) {
        if (order) {
          await order.update({ status: status.CANCELLED });
          await order.Subscription.deactivate();
        }
      }
    }
  }
}

/* eslint-disable camelcase */
function parseCommandLineArguments() {
  const parser = new ArgumentParser({
    add_help: true,
    description: 'Check and update Hosts in the new model',
  });
  parser.add_argument('--dryrun', {
    help: "Don't perform any change, just log.",
    default: false,
    action: 'store_const',
    const: true,
  });
  const args = parser.parse_args();
  return {
    dryRun: args.dryrun,
  };
}

/* eslint-enable camelcase */

if (require.main === module) {
  run(parseCommandLineArguments())
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
