import '../../server/env';

import fs from 'fs';

import { Parser } from '@json2csv/plainjs';
import { Command } from 'commander';
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
import { runCronJob } from '../utils';

const json2csv = (data, opts = undefined) => new Parser(opts).parse(data);

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

/** Run the script with parameters read from the command line */
async function run(options) {
  options.startDate = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();

  const queue = new PQueue({ concurrency: options.concurrency });

  const { count, rows: orders } = await ordersWithPendingCharges({
    limit: options.limit,
    startDate: options.startDate,
    limitedToOrderIds: options.orderIds,
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

  return await queue.onIdle().then(async () => {
    if (data.length === 0) {
      // We used to send a "ReportNoCharges" here but we're stopping this while moving to an Hourly schedule
      console.log('Not generating CSV file');
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
function parseCommandLineArguments() {
  const program = new Command()
    .description('Charge due recurring contributions')
    .option('--dryrun', "Don't perform any payment or change to the database", false)
    .option('-l, --limit <n>', 'Total recurring contributions to process', Number, 500)
    .option('-c, --concurrency <n>', 'Number of operations to process at the same time', Number, 3)
    .option('-s, --simulate', 'If in dry run, simulate operation between 0 to 5 seconds', false)
    .option('--orders <ids>', 'Comma separated list of order ids to process')
    .parse(process.argv);

  const opts = program.opts();
  return {
    dryRun: opts.dryrun,
    limit: opts.limit,
    concurrency: opts.concurrency,
    simulate: opts.simulate,
    orderIds: opts.orders
      ? opts.orders.split(',').map(str => {
          const num = Number(str);
          if (isNaN(num)) {
            throw new Error(`Invalid order id: ${str}`);
          }
          return num;
        })
      : undefined,
  };
}

/** Kick off the script with all the user selected options */
if (require.main === module) {
  if (parseToBoolean(process.env.SKIP_CHARGE_RECURRING_CONTRIBUTIONS) && !process.env.OFFCYCLE) {
    console.log('Skipping because SKIP_CHARGE_RECURRING_CONTRIBUTIONS is set.');
    process.exit();
  }
  runCronJob('charge-recurring-contributions', () => run(parseCommandLineArguments()), 60 * 60);
}
