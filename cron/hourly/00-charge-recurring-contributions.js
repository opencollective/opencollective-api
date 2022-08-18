#!/usr/bin/env node
import '../../server/env';

import fs from 'fs';

import { ArgumentParser } from 'argparse';
import { parse as json2csv } from 'json2csv';
import PQueue from 'p-queue';

import FEATURE from '../../server/constants/feature';
import emailLib from '../../server/lib/email';
import {
  groupProcessedOrders,
  ordersWithPendingCharges,
  processOrderWithSubscription,
} from '../../server/lib/recurring-contributions';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { parseToBoolean } from '../../server/lib/utils';
import { sequelize } from '../../server/models';

const REPORT_EMAIL = 'ops@opencollective.com';

// These field names are the ones returned by
// processOrderWithSubscription().
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
  'nextPeriodStartAfter',
];

const startTime = new Date();

if (parseToBoolean(process.env.SKIP_CHARGE_RECURRING_CONTRIBUTIONS) && !process.env.OFFCYCLE) {
  console.log('Skipping because SKIP_CHARGE_RECURRING_CONTRIBUTIONS is set.');
  process.exit();
}

/** Run the script with parameters read from the command line */
async function run(options) {
  options.startDate = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();

  const queue = new PQueue({ concurrency: Number(options.concurrency) });

  const { count, rows: orders } = await ordersWithPendingCharges({
    limit: options.limit,
    startDate: options.startDate,
  });
  console.log(
    `${count} recurring contributions pending charges. Charging ${orders.length} contributions right now. dryRun: ${options.dryRun}`,
  );
  const data = [];

  for (const order of orders) {
    queue.add(() =>
      processOrderWithSubscription(order, options)
        .then(csvEntry => {
          if (csvEntry) {
            data.push(csvEntry);
          }
        })
        .catch(err => {
          console.log(`Error while processing order #${order.id} ${err.message}`);
          reportErrorToSentry(err, { severity: 'fatal', tags: { feature: FEATURE.RECURRING_CONTRIBUTIONS } });
        }),
    );
  }

  queue.onIdle().then(async () => {
    if (data.length === 0) {
      await sequelize.close();
      console.log('Not generating CSV file');
      // We used to send a "ReportNoCharges" here but we're stopping this while moving to an Hourly schedule
      return;
    }
    console.log('Writing the output to a CSV file');
    try {
      const csv = json2csv(data, { fields: csvFields });
      if (options.dryRun) {
        fs.writeFileSync('charge_recurring_contributions.output.csv', csv);
      }
      if (!options.dryRun) {
        console.log('Sending email report');
        const attachments = [
          {
            filename: `${new Date().toLocaleDateString()}.csv`,
            content: csv,
          },
        ];
        await emailReport(orders, groupProcessedOrders(data), attachments);
      }
    } catch (err) {
      console.log(`Error while generating report ${err.message}`);
      reportErrorToSentry(err, { severity: 'fatal', tags: { feature: FEATURE.RECURRING_CONTRIBUTIONS } });
    }

    await sequelize.close();
    console.log('Finished running charge recurring contributions');
  });
}

/** Send an email with details of the subscriptions processed */
async function emailReport(orders, data, attachments) {
  const icon = err => (err ? '❌' : '✅');
  let result = [`Total recurring contributions pending charges found: ${orders.length}`, ''];

  // Add entries of each group to the result list
  const printGroup = ([name, { total, entries }]) => {
    result.push(`>>> ${entries.length} orders ${name} (sum of amounts: ${total})`);
    result = result.concat(
      entries.map(i =>
        [
          ` ${i.status !== 'unattempted' ? icon(i.error) : ''} order: ${i.orderId}`,
          `subscription: ${i.subscriptionId}`,
          `amount: ${i.amount}`,
          `from: ${i.from}`,
          `to: ${i.to}`,
          `status: ${i.status}`,
          `error: ${i.error}`,
        ].join(', '),
      ),
    );
    result.push('');
  };

  // Iterate over grouped orders to populate the result list with
  // details of each group
  for (const group of data) {
    printGroup(group);
  }

  // Time we spent running the whole script
  const now = new Date();
  const end = now - startTime;
  result.push(`\n\nTotal time taken: ${end}ms`);

  // Subject line of the email
  const subject = `Recurring Contributions Report - ${now.toLocaleDateString()}`;

  // Actual send
  return emailLib.sendMessage(REPORT_EMAIL, subject, '', {
    text: result.join('\n'),
    attachments,
  });
}

/** Return the options passed by the user to run the script */
/* eslint-disable camelcase */
export function parseCommandLineArguments() {
  const parser = new ArgumentParser({
    add_help: true,
    description: 'Charge due recurring contributions',
  });
  parser.add_argument('--dryrun', {
    help: "Don't perform any payment or change to the database",
    default: false,
    action: 'store_const',
    const: true,
  });
  parser.add_argument('-l', '--limit', {
    help: 'Total recurring contributions to process',
    default: 500,
  });
  parser.add_argument('-c', '--concurrency', {
    help: 'Number of operations to process at the same time',
    default: 3,
  });
  parser.add_argument('-s', '--simulate', {
    help: 'If in dry run, simulate operation between 0 to 5 seconds',
    default: false,
    action: 'store_const',
    const: true,
  });
  const args = parser.parse_args();
  return {
    dryRun: args.dryrun,
    limit: args.limit,
    concurrency: args.concurrency,
    simulate: args.simulate,
  };
}
/* eslint-enable camelcase */

/** Kick off the script with all the user selected options */
export async function entryPoint(options) {
  await run(options);
}

/* Entry point */
entryPoint(parseCommandLineArguments());
