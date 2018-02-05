import fs from 'fs';
import moment from 'moment';
import json2csv from 'json2csv';
import { ArgumentParser } from 'argparse';
import { Op } from 'sequelize';

import models, { sequelize } from '../server/models';
import { promiseSeq } from '../server/lib/utils';
import * as stripeGateway from '../server/paymentProviders/stripe/gateway';

const csvFields = [
  'orderId',
  'localSubscriptionId',
  'stripeSubscriptionId',
  'stripeStatus',
  'newDate',
  'newDateHuman',
  'state',
  'error',
];


function successLine(order, stripeStatus, newDate) {
  return {
    orderId: order.id,
    localSubscriptionId: order.Subscription.id,
    stripeSubscriptionId: order.Subscription.stripeSubscriptionId,
    stripeStatus,
    newDate,
    newDateHuman: newDate ? moment(newDate * 1000).format() : newDate,
    state: 'done',
    error: ''
  };
}

function errorLine(order, state, error) {
  return {
    orderId: order.id,
    localSubscriptionId: order.Subscription.id,
    stripeSubscriptionId: order.Subscription.stripeSubscriptionId,
    stripeStatus: '',
    newDate: '',
    newDateHuman: '',
    state,
    error: error.message
  };
}

async function updateLocalSubscription(order, stripeSubscription) {
  let date;
  switch (stripeSubscription.status) {
  case 'trialing':
    date = stripeSubscription.trial_end;
    break;
  case 'active':
    date = stripeSubscription.current_period_end;
    break;
  case 'past_due':
    if (stripeSubscription.trial_end) {
      date = stripeSubscription.trial_end;
    } else {
      date = stripeSubscription.current_period_end;
    }
    break;
  case 'unpaid':
    date = stripeSubscription.current_period_end;
    break;
  case 'cancelled':
    // cancel the subscription in our DB
    date = null;
    break;
  }

  if (date) {
    // Initialize both dates with the same value
    order.Subscription.nextChargeDate = new Date(date * 1000);
    order.Subscription.nextPeriodStart = new Date(date * 1000);
  } else {
    // Cancel the subscription
    order.Subscription.isActive = false;
    order.Subscription.deactivatedAt = new Date;
  }
  return { status: stripeSubscription.status, date };
}

/** Update subscription database entry with data from stripe.
 *
 * This function is executed for each order and returns a line that
 * will compose the CSV output.
 */
async function eachOrder(order, options) {
  let stripeAccount, stripeSubscription, updates;
  const { stripeSubscriptionId } = order.Subscription;
  try {
    stripeAccount = await order.collective.getHostStripeAccount();
  } catch (error) {
    return errorLine(order, 'getStripeHost', error);
  }
  try {
    stripeSubscription = await stripeGateway.retrieveSubscription(
      stripeAccount, stripeSubscriptionId);
  } catch (error) {
    return errorLine(order, 'getStripeAccount', error);
  }

  // At this point all the useful information was collected. It's now
  // time to make changes to the database. First we update the dates
  // that subscriptions should be charged
  try {
    updates = await updateLocalSubscription(order, stripeSubscription);
    if (!options.dryRun) {
      await order.Subscription.save();
    }
  } catch (error) {
    return errorLine(order, 'updateLocalSubscription', error);
  }

  // Then cancel the subscription on stripe if we're doing it for real
  if (!options.dryRun) {
    try {
      await stripeGateway.cancelSubscription(stripeAccount, stripeSubscriptionId);
    } catch (error) {
      return errorLine(order, 'cancelStripeSubscription', error);
    }
  }

  // All good, just save important info
  return successLine(order, updates.status, updates.date);
}

/** Run the script with parameters read from the command line */
async function run(options) {
  const allOrders = await findStripeSubscriptions();
  const orders = (options.limit) ? allOrders.slice(0, options.limit) : allOrders;
  vprint(options, `Migrating ${orders.length} subscriptions from a total of ${allOrders.length} (dryRun: ${options.dryRun})`);
  const data = [];
  await promiseSeq(orders, async (o) => {
    const line = await eachOrder(o, options);
    data.push(line);
    vprint(options,
           `orderId: ${line.orderId}, subId: ${line.localSubscriptionId} ` +
           `stripeSubId: ${line.stripeSubscriptionId}, stripeStatus: ${line.stripeStatus} ` +
           `state: ${line.state}, error: ${line.error}.`);
  }, options.batchSize);

  if (data.length > 0) {
    json2csv({ data, csvFields }, (err, csv) => {
      vprint(options, 'Writing the output to a CSV file');
      if (err) console.log(err);
      else fs.writeFileSync('move_subscriptions_from_stripe.output.csv', csv);
    });
  } else {
    vprint(options, 'Not generating CSV file');
  }
}

/** Find all active subscriptions with a stripeSubscriptionId */
async function findStripeSubscriptions() {
  return models.Order.findAll({
    order: ['id'],
    where: { SubscriptionId: { [Op.ne]: null } },
    include: [{
      model: models.Subscription,
      where: {
        isActive: true,
        deletedAt: null,
        deactivatedAt: null,
        activatedAt: { [Op.lte]: new Date },
        nextChargeDate: null,
        stripeSubscriptionId: { [Op.ne]: null }
      }
    }, {
      model: models.Collective,
      as: 'collective'
    }]
  });
}

/** Print `message` to console if `options.verbose` is true */
function vprint(options, message) {
  if (options.verbose) {
    console.log(message);
  }
}

/** Return the options passed by the user to run the script */
function parseCommandLineArguments() {
  const parser = new ArgumentParser({
    addHelp: true,
    description: 'Charge due subscriptions'
  });
  parser.addArgument(['-v', '--verbose'], {
    help: 'Verbose output',
    defaultValue: false,
    action: 'storeConst',
    constant: true
  });
  parser.addArgument(['--notdryrun'], {
    help: "Pass this flag when you're ready to run the script for real",
    defaultValue: false,
    action: 'storeConst',
    constant: true
  });
  parser.addArgument(['-l', '--limit'], {
    help: 'total subscriptions to process'
  });
  parser.addArgument(['-b', '--batch_size'], {
    help: 'batch size to fetch at a time',
    defaultValue: 10
  });
  const args = parser.parseArgs();
  return {
    dryRun: !args.notdryrun,
    verbose: args.verbose,
    limit: args.limit,
    batchSize: args.batch_size || 100
  };
}

/** Kick off the script with all the user selected options */
async function entryPoint(options) {
  vprint(options, 'Starting subscription migration');
  try {
    await run(options);
  } finally {
    await sequelize.close();
  }
  vprint(options, 'Finished subscription migration');
}

/* Entry point */
entryPoint(parseCommandLineArguments());
