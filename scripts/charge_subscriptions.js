import fs from 'fs';
import json2csv from 'json2csv';
import moment from 'moment';
import { ArgumentParser } from 'argparse';

import * as payments from '../server/lib/payments';
import emailLib from '../server/lib/email';
import { promiseSeq } from '../server/lib/utils';
import { sequelize } from '../server/models';
import {
  ordersWithPendingCharges,
  updateNextChargeDate,
  updateChargeRetryCount,
  handleRetryStatus,
} from '../server/lib/subscriptions';

const csvFields = [
  'orderId',
  'subscriptionId',
  'amount',
  'from',
  'to',
  'status',
  'error',
  'retriesBefore',
  'retriesAfter',
  'chargeDateBefore',
  'chargeDateAfter',
  'nextPeriodStartBefore',
  'nextPeriodStartAfter'
];

/** Standard way to format dates in this script */
function dateFormat(date) {
  return moment(date).format();
}

/** Process order and trigger result handlers.
 *
 * Uses `lib.payments.processOrder()` to charge subscription and
 * handle both success and failure of that processing.
 */
async function processOrderWithSubscription(options, order) {
  const csvEntry = {
    orderId: order.id,
    subscriptionId: order.Subscription.id,
    amount: order.totalAmount,
    from: order.fromCollective.slug,
    to: order.collective.slug,
    status: null,
    error: null,
    retriesBefore: order.Subscription.chargeRetryCount,
    retriesAfter: null,
    chargeDateBefore: dateFormat(order.Subscription.nextCharge),
    chargeDateAfter: null,
    nextPeriodStartBefore: dateFormat(order.Subscription.nextPeriodStart),
    nextPeriodStartAfter: null
  };

  let status, transaction;
  if (!options.dryRun) {
    try {
      transaction = await payments.processOrder(order);
      status = 'success';
    } catch (error) {
      status = 'failure';
      csvEntry.error = error.message;
    }
  }

  updateNextChargeDate(status, order);
  updateChargeRetryCount(status, order);

  csvEntry.status = status;
  csvEntry.retriesAfter = order.Subscription.chargeRetryCount;
  csvEntry.chargeDateAfter = dateFormat(order.Subscription.nextChargeDate);
  csvEntry.nextPeriodStartAfter = dateFormat(order.Subscription.nextPeriodStart);

  if (!options.dryRun) {
    await handleRetryStatus(order, transaction);
    await order.Subscription.save();
  }

  return csvEntry;
}

/** Run the script with parameters read from the command line */
async function run(options) {
  const start = new Date;
  const orders = await ordersWithPendingCharges();
  vprint(options, `${orders.length} subscriptions pending charges. dryRun: ${options.dryRun}`);
  const data = [];
  await promiseSeq(orders, async (order) => {
    vprint(options,
           `order: ${order.id}, subscription: ${order.Subscription.id}, ` +
           `attempt: #${order.Subscription.chargeRetryCount}, ` +
           `due: ${order.Subscription.nextChargeDate}`);
    data.push(await processOrderWithSubscription(options, order));
  }, options.batchSize);

  if (data.length > 0) {
    json2csv({ data, fields: csvFields }, (err, csv) => {
      vprint(options, 'Writing the output to a CSV file');
      if (err) console.log(err);
      else fs.writeFileSync('charge_subscriptions.output.csv', csv);
    });
  } else {
    vprint(options, 'Not generating CSV file');
  }
  if (!options.dryRun) {
    vprint(options, 'Sending email report');
    await emailReport(start, orders, data);
  }
}

async function emailReport(start, orders, data) {
  let issuesFound = false;
  const result = [`Total Subscriptions pending charges found: ${orders.length}\n`];

  data.map((i) => {
    if (i.status !== null) issuesFound = true;
    return [i.orderId, i.subscriptionId, i.amount, i.from, i.to, i.status].join('');
  });

  result.push("\n\nTotal time taken: ", new Date() - start, "ms");
  const subject = `${issuesFound ? '❌' : '✅'} Daily Subscription Report - ${(new Date()).toLocaleDateString()}`;
  return emailLib.sendMessage('ops@opencollective.com', subject, '', { bcc: ' ', text: result.join('\n') });
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
    description: 'Charge due subscriptions',
  });
  parser.addArgument(['-v', '--verbose'], {
    help: 'Verbose output',
    defaultValue: false,
    action: 'storeConst',
    constant: true,
  });
  parser.addArgument(['--notdryrun'], {
    help: "Pass this flag when you're ready to run the script for real",
    defaultValue: false,
    action: 'storeConst',
    constant: true,
  });
  parser.addArgument(['-b', '--batch_size'], {
    help: 'batch size to fetch at a time',
    defaultValue: 10
  });
  const args = parser.parseArgs();
  return {
    dryRun: !args.notdryrun,
    verbose: args.verbose,
    batchSize: args.batch_size || 100
  };
}

/** Kick off the script with all the user selected options */
async function entryPoint(options) {
  vprint(options, 'Starting to charge subscriptions');
  try {
    await run(options);
  } finally {
    await sequelize.close();
  }
  vprint(options, 'Finished running charge subscriptions');
}

/* Entry point */
entryPoint(parseCommandLineArguments());
