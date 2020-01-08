#!/usr/bin/env node
import '../../server/env';

/**
 * Makes sure all collectives.plan are up-to-date, downgrading and cancelling plans if needed.
 */

// Only run on the first of the month
const today = new Date();
if (process.env.NODE_ENV === 'production' && today.getDate() !== 1) {
  console.log('NODE_ENV is production and today is not the first of month, script aborted!');
  process.exit();
}

process.env.PORT = 3066;

import { Op } from 'sequelize';
import { compact, findKey, get, groupBy, map, values, pipe } from 'lodash/fp';
import debugLib from 'debug';

import models from '../../server/models';
import { promiseSeq } from '../../server/lib/utils';
import plans, { PLANS_COLLECTIVE_SLUG } from '../../server/constants/plans';
import orderStatus from '../../server/constants/order_status';
import emailLib from '../../server/lib/email';

const debug = debugLib('verify-plans');

const d = new Date();
d.setMonth(d.getMonth() - 1);

const START_DATE = new Date(d.getFullYear(), d.getMonth(), 1);
const END_DATE = new Date(d.getFullYear(), d.getMonth() + 1, 1);
const REPORT_EMAIL = 'ops@opencollective.com';
const BATCH_SIZE = 10;
const EXISTING_PLANS_SLUGS = pipe(values, map(get('slug')), compact)(plans);

const LEVELS = {
  LEGACY: 'LEGACY',
  DOWNGRADE: 'DOWNGRADE',
  CANCEL: 'CANCEL',
  EXCEPTION: 'EXCEPTION',
};

export async function run(options = {}) {
  const collectives = await models.Collective.findAll({ where: { plan: { [Op.ne]: null } } });
  debug(`There is/are ${collectives.length} subscribed to our plans...`);

  const info = [];

  await promiseSeq(
    collectives,
    async c => {
      debug(`Processing collective #${c.id}...`);
      // Custom or legacy plans, we're ignoring this because this was manually set.
      if (!plans[c.plan].slug) {
        return info.push({
          level: LEVELS.LEGACY,
          message: `${c.slug} is using legacy plan, ignoring.`,
        });
      }

      const [lastOrder] = await models.Order.findAll({
        include: [
          { model: models.Collective, as: 'collective', where: { slug: PLANS_COLLECTIVE_SLUG } },
          { model: models.Collective, as: 'fromCollective', where: { id: c.id } },
          { model: models.Subscription, as: 'Subscription' },
          { model: models.Tier, as: 'Tier', where: { slug: { [Op.in]: EXISTING_PLANS_SLUGS } } },
        ],
        limit: 1,
        order: [['updatedAt', 'DESC']],
      });

      const lastOrderPlan = findKey({ slug: lastOrder.Tier.slug }, plans);
      // Last order matches the plan and it is still active.
      if (c.plan === lastOrderPlan && lastOrder.status === orderStatus.ACTIVE) {
        return;
      }
      // Last order matches the plan but was cancelled.
      else if (c.plan === lastOrderPlan && lastOrder.status === orderStatus.CANCELLED) {
        await c.update({ plan: null });
        return info.push({
          level: LEVELS.CANCEL,
          message: `Collective ${c.slug} cancelled ${c.plan}.`,
        });
      }
      // Last order doesn't match the current plan, must have been downgraded since upgrades
      // are updated in real time.
      else if (c.plan !== lastOrderPlan && lastOrder.status === orderStatus.ACTIVE) {
        await c.update({ plan: lastOrderPlan });
        return info.push({
          level: LEVELS.DOWNGRADE,
          message: `Collective ${c.slug} downgraded from ${c.plan} to ${lastOrderPlan}.`,
        });
      } else {
        return info.push({
          level: LEVELS.EXCEPTION,
          message: `Collective ${c.slug} is set to ${c.plan} but its last plan update is ${lastOrderPlan}. Please investigate.`,
        });
      }
    },
    options.batch,
  );

  return info;
}

if (require.main === module) {
  console.log('startDate', START_DATE, 'endDate', END_DATE);

  const info = run({ batch: BATCH_SIZE });

  const { LEGACY, DOWNGRADE, CANCEL, EXCEPTION } = groupBy('level', info);
  let body = [];
  let subjectIcon;

  if (LEGACY) {
    subjectIcon = 'ℹ️';
    body = [`ℹ️ Other plans being used:\n`, ...LEGACY.map(info => `${info.message}\n`)];
  }
  if (DOWNGRADE) {
    subjectIcon = '👎';
    body = [`👎 Downgrades:\n`, ...DOWNGRADE.map(info => `${info.message}\n`), `\n`, ...body];
  }
  if (CANCEL) {
    subjectIcon = '🚫';
    body = [`🚫 Cancellations:\n`, ...CANCEL.map(info => `${info.message}\n`), `\n`, ...body];
  }
  if (EXCEPTION) {
    subjectIcon = '🚨';
    body = [`🚨 Exceptions:\n`, ...EXCEPTION.map(info => `${info.message}\n`), `\n`, ...body];
  }

  // Time we spent running the whole script
  const now = new Date();
  const end = now - START_DATE;
  if (body.length === 0) {
    const text = `No subscriptions pending charges found\n\nTotal time taken: ${end}ms`;
    const subject = `Ø Monthly Plan Verification Report - ${now.toLocaleDateString()}`;
    emailLib.sendMessage(REPORT_EMAIL, subject, '', { text });
  } else if (body.lenght > 0) {
    // Build & send message
    body.push(`\n\nTotal time taken: ${end}ms`);
    const text = body.join('\n');
    const subject = `${subjectIcon} Monthly Plan Verification Report - ${now.toLocaleDateString()}`;
    emailLib.sendMessage(REPORT_EMAIL, subject, '', { text });
  }
}
