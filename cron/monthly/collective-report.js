import '../../server/env';

import config from 'config';
import { omit, pick } from 'lodash';
import moment from 'moment';
import pMap from 'p-map';

import { roles } from '../../server/constants';
import ActivityTypes from '../../server/constants/activities';
import { TransactionKind } from '../../server/constants/transaction-kind';
import { generateHostFeeAmountForTransactionLoader } from '../../server/graphql/loaders/transactions';
import { getCollectiveTransactionsCsv } from '../../server/lib/csv';
import { notify } from '../../server/lib/notifications/email';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { getTiersStats, parseToBoolean } from '../../server/lib/utils';
import models, { Op } from '../../server/models';
import { runCronJob } from '../utils';

// Only run on the first of the month
const today = new Date();
if (config.env === 'production' && today.getDate() !== 1 && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and today is not the first of month, script aborted!');
  process.exit();
} else if (parseToBoolean(process.env.SKIP_COLLECTIVE_REPORT)) {
  console.log('Skipping because SKIP_COLLECTIVE_REPORT is set.');
  process.exit();
}

process.env.PORT = 3066;
const CONCURRENCY = process.env.CONCURRENCY || 1;

const d = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();
d.setMonth(d.getMonth() - 1);
const month = moment(d).format('MMMM');
const year = d.getFullYear();
const dateFormat = 'YYYYMM';

const startDate = new Date(d.getFullYear(), d.getMonth(), 1);
const endDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);

console.log('startDate', startDate, 'endDate', endDate);

const processCollectives = collectives => {
  return pMap(collectives, processCollective, { concurrency: CONCURRENCY });
};

const hostFeeAmountForTransactionLoader = generateHostFeeAmountForTransactionLoader();

const enrichTransactionsWithHostFee = async transactions => {
  const hostFees = await hostFeeAmountForTransactionLoader.loadMany(transactions);
  transactions.forEach((transaction, idx) => {
    const hostFeeInHostCurrency = hostFees[idx];
    if (hostFeeInHostCurrency && hostFeeInHostCurrency !== transaction.hostFeeInHostCurrency) {
      transaction.hostFeeInHostCurrency = hostFees[idx];
      transaction.netAmountInCollectiveCurrency =
        models.Transaction.calculateNetAmountInCollectiveCurrency(transaction);
    }
  });
  return transactions;
};

const init = async () => {
  const startTime = new Date();

  const query = {
    attributes: ['id', 'slug', 'name', 'twitterHandle', 'currency', 'settings', 'tags'],
    where: {
      type: { [Op.in]: ['COLLECTIVE', 'ORGANIZATION'] },
      isActive: true,
    },
    order: [['id', 'ASC']],
  };

  let slugs;
  if (process.env.DEBUG && process.env.DEBUG.match(/preview/)) {
    slugs = [
      'vuejs',
      'webpack',
      'wwcodeaustin',
      'railsgirlsatl',
      'cyclejs',
      'mochajs',
      'chsf',
      'freeridetovote',
      'tipbox',
    ];
  }
  if (process.env.SLUGS) {
    slugs = process.env.SLUGS.split(',');
  }
  if (slugs) {
    query.where.slug = { [Op.in]: slugs };
  }

  if (process.env.SKIP_SLUGS) {
    const skipSlugs = process.env.SKIP_SLUGS.split(',');
    query.where.slug = { [Op.notIn]: skipSlugs };
  }

  if (process.env.AFTER_ID) {
    query.where.id = { [Op.gt]: Number(process.env.AFTER_ID) };
  }

  const collectives = await models.Collective.findAll(query);

  console.log(`Preparing the ${month} report for ${collectives.length} collectives`);

  processCollectives(collectives).then(() => {
    const timeLapsed = Math.round((new Date() - startTime) / 1000);
    console.log(`Total run time: ${timeLapsed}s`);
    process.exit(0);
  });
};

const processCollective = async collective => {
  const promises = [
    collective.getTiersWithUsers({
      attributes: ['id', 'slug', 'name', 'image', 'firstDonation', 'lastDonation', 'totalDonations', 'tier'],
      until: endDate,
    }),
    collective.getBalance({ endDate }),
    collective.getTotalTransactions(startDate, endDate, 'donation'),
    collective.getTotalTransactions(startDate, endDate, 'expense'),
    collective.getExpenses(null, startDate, endDate),
    collective.getBackersStats(startDate, endDate),
    collective.getNewOrders(startDate, endDate, { status: { [Op.or]: ['ACTIVE', 'PAID'] } }),
    collective.getCancelledOrders(startDate, endDate),
    collective.getUpdates('published', startDate, endDate),
    collective.getNextGoal(endDate),
    collective.getTransactions({
      startDate,
      endDate,
      kinds: Object.values(
        omit(TransactionKind, [
          'HOST_FEE', // Host fee is loaded separately and added as a column
          'HOST_FEE_SHARE', // Not surfaced yet, to keep the report as close to the previous version as possible
          'HOST_FEE_SHARE_DEBT', // Not surfaced yet, to keep the report as close to the previous version as possible
        ]),
      ),
    }),
  ];

  let emailData = { isSystem: true };
  const options = { attachments: [], role: [roles.ADMIN, roles.ACCOUNTANT] };
  const csvFilename = `${collective.slug}-${moment(d).format(dateFormat)}-transactions.csv`;

  return Promise.all(promises)
    .then(results => {
      console.log('***', collective.name, '***');
      const data = {
        config: { host: config.host },
        month,
        year,
        collective: {},
      };
      return getTiersStats(results[0], startDate, endDate).then(async res => {
        data.collective = pick(collective, ['id', 'name', 'slug', 'currency', 'publicUrl']);
        data.collective.tiers = res.tiers.map(tier => ({
          ...tier.info,
          amountStr: tier.amountStr,
          activeBackers: tier.activeBackers,
        }));
        data.collective.backers = res.backers;
        data.collective.stats = results[5];
        data.collective.newOrders = results[6];
        data.collective.cancelledOrders = results[7];
        data.collective.stats.balance = results[1];
        data.collective.stats.totalDonations = results[2];
        data.collective.stats.totalExpenses = results[3];
        data.collective.expenses = results[4].map(expense => expense.info);
        data.collective.updates = results[8].map(u => u.info);
        data.collective.transactions = await enrichTransactionsWithHostFee(results[10]);
        const nextGoal = results[9];
        if (nextGoal) {
          nextGoal.tweet = `🚀 ${collective.twitterHandle ? `@${collective.twitterHandle}` : collective.name} is at ${
            nextGoal.percentage
          } of their next goal: ${nextGoal.title}.\nHelp us get there! 🙌\nhttps://opencollective.com/${
            collective.slug
          }`;
          data.collective.nextGoal = nextGoal;
        }

        if (data.collective.transactions && data.collective.transactions.length > 0) {
          const collectivesById = { [collective.id]: collective };
          const csv = models.Transaction.exportCSV(data.collective.transactions, collectivesById);

          options.attachments.push({
            filename: csvFilename,
            content: csv,
          });
        }

        emailData = data;
        return collective;
      });
    })
    .then(async collective => {
      if (emailData.collective.transactions && emailData.collective.transactions.length > 0) {
        const transactionsCsvV2 = await getCollectiveTransactionsCsv(collective, { startDate, endDate });
        if (transactionsCsvV2) {
          const csvFilenameV2 = `${collective.slug}-${moment(d).format(dateFormat)}-transactions-v2.csv`;
          options.attachments.push({
            filename: csvFilenameV2,
            content: transactionsCsvV2,
          });
          emailData.csvV2 = true;
        }
      }
      return collective;
    })
    .then(async collective => {
      const activity = {
        type: ActivityTypes.COLLECTIVE_MONTHLY_REPORT,
        CollectiveId: collective.id,
        data: emailData,
      };
      return notify.collective(activity, options);
    })
    .catch(e => {
      console.error('Error in processing collective', collective.slug, e);
      reportErrorToSentry(e);
    });
};

runCronJob('collective-report', init, 23 * 60 * 60 * 1000);
