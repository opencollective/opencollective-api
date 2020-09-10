#!/usr/bin/env node
import '../../server/env';

import fs from 'fs';

import { ArgumentParser } from 'argparse';
import { parse as json2csv } from 'json2csv';
import PQueue from 'p-queue';

import emailLib from '../../server/lib/email';
import {
  groupProcessedOrders,
  ordersWithPendingCharges,
  processOrderWithSubscription,
} from '../../server/lib/recurring-contributions';
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

/** Print `message` to console if `options.verbose` is true */
function vprint(options, message) {
  if (options.verbose) {
    console.log(message);
  }
}

const startTime = new Date();

/** Run the script with parameters read from the command line */
async function run(options) {
  options.startDate = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();

  const queue = new PQueue({ concurrency: Number(options.concurrency) });

  const { count, rows: orders } = await ordersWithPendingCharges({
    limit: options.limit,
    startDate: options.startDate,
  });
  vprint(
    options,
    `${count} recurring contributions pending charges. Charging ${orders.length} contributions right now. dryRun: ${options.dryRun}`,
  );
  const data = [];

  for (const order of orders) {
    queue.add(() =>
      processOrderWithSubscription(order, options).then(csvEntry => {
        if (csvEntry) {
          data.push(csvEntry);
        }
      }),
    );
  }

  queue.onIdle().then(async () => {
    if (data.length === 0) {
      await sequelize.close();
      vprint(options, 'Not generating CSV file');
      // We used to send a "ReportNoCharges" here but we're stopping this while moving to an Hourly schedule
      return;
    }
    vprint(options, 'Writing the output to a CSV file');
    try {
      const csv = json2csv(data, { fields: csvFields });
      if (options.dryRun) {
        fs.writeFileSync('charge_recurring_contributions.output.csv', csv);
      }
      if (!options.dryRun) {
        vprint(options, 'Sending email report');
        const attachments = [
          {
            filename: `${new Date().toLocaleDateString()}.csv`,
            content: csv,
          },
        ];
        await emailReport(orders, groupProcessedOrders(data), attachments);
      }
    } catch (err) {
      console.log(err);
    }

    await sequelize.close();
    vprint(options, 'Finished running charge recurring contributions');
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
    bcc: ' ',
    text: result.join('\n'),
    attachments,
  });
}

/** Return the options passed by the user to run the script */
export function parseCommandLineArguments() {
  const parser = new ArgumentParser({
    addHelp: true,
    description: 'Charge due recurring contributions',
  });
  parser.addArgument(['-q', '--quiet'], {
    help: 'Silence output',
    defaultValue: false,
    action: 'storeConst',
    constant: true,
  });
  parser.addArgument(['--dryrun'], {
    help: "Don't perform any changes to the database",
    defaultValue: false,
    action: 'storeConst',
    constant: true,
  });
  parser.addArgument(['-l', '--limit'], {
    help: 'total recurring contributions to process',
    defaultValue: 1000,
  });
  parser.addArgument(['-c', '--concurrency'], {
    help: 'concurrency',
    defaultValue: 5,
  });
  parser.addArgument(['-s', '--simulate'], {
    help: 'concurrency',
    defaultValue: false,
    action: 'storeConst',
    constant: true,
  });
  const args = parser.parseArgs();
  return {
    dryRun: args.dryrun,
    verbose: !args.quiet,
    limit: args.limit,
    concurrency: args.concurrency,
    simulate: args.simulate,
  };
}

/** Kick off the script with all the user selected options */
export async function entryPoint(options) {
  await run(options);
}

/* Entry point */
entryPoint(parseCommandLineArguments());
