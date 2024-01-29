#!/usr/bin/env node
import '../server/env';

import { ArgumentParser } from 'argparse';

import { PLANS_COLLECTIVE_SLUG } from '../server/constants/plans';
import models, { Op } from '../server/models';

async function run({ dryRun } = {}) {
  const hosts = await models.Collective.findAll({
    where: {
      isHostAccount: { [Op.is]: true },
      hostFeePercent: 0,
    },
  });

  const opencollective = await models.Collective.findOne({
    where: { slug: PLANS_COLLECTIVE_SLUG },
    include: [{ model: models.Tier, as: 'tiers', where: { type: 'TIER', deletedAt: null } }],
  });

  const existingPlansSlugs = opencollective.tiers.map(tier => tier.slug);

  for (const host of hosts) {
    console.log(`Checking ${host.slug}`);
    if (!host.isActive) {
      console.log(`- Activating Budget`);
      if (!dryRun) {
        await host.activateBudget({ remoteUser: { id: 12457 } });
      }
    }

    if (host.platformFeePercent !== 0) {
      console.log(`- Activating Platform Tips`);
      if (!dryRun) {
        await host.update({ platformFeePercent: 0 });
        // MISSED: should have been a cascade, ie:  host.updatePlatformFee
      }
    }

    if (host.plan && ['single-host-plan', 'small-host-plan'].includes(host.plan)) {
      console.log(`- Cancelling Existing Plan`);
      const order = await models.Order.findOne({
        include: [
          { model: models.Collective, as: 'collective', where: { slug: PLANS_COLLECTIVE_SLUG } },
          { model: models.Collective, as: 'fromCollective', where: { id: host.id } },
          { association: 'Subscription' },
          { association: 'Tier', where: { slug: { [Op.in]: existingPlansSlugs } } },
        ],
        order: [['updatedAt', 'DESC']],
      });
      if (!order) {
        console.warn(`- No Order found!`);
      }
      if (!dryRun) {
        if (order) {
          await order.update({ status: status.CANCELLED });
          await order.Subscription.deactivate();
        }
      }
    }

    if (!host.plan || !['owned', 'custom', 'grow-plan-2021', 'start-plan-2021'].includes(host.plan)) {
      console.log(`- Updating Plan`);
      if (!dryRun) {
        await host.update({ plan: 'start-plan-2021' });
      }
    }
  }
}

/* eslint-disable camelcase */
function parseCommandLineArguments() {
  const parser = new ArgumentParser({
    add_help: true,
    description: 'Migrate Hosts without Host Fees to the new model',
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
