#!/usr/bin/env node
import '../../server/env';

import Promise from 'bluebird';
import config from 'config';
import { isEmpty, pick } from 'lodash';
import moment from 'moment';

import { notifyAdminsOfCollective } from '../../server/lib/notifications';
import { getConsolidatedInvoicePdfs } from '../../server/lib/pdf';
import { getTiersStats } from '../../server/lib/utils';
import models, { Op } from '../../server/models';

// Only run on the first of the month
const today = new Date();
if (config.env === 'production' && today.getDate() !== 1 && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and today is not the first of month, script aborted!');
  process.exit();
}

process.env.PORT = 3066;

const d = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();
d.setMonth(d.getMonth() - 1);
const month = moment(d).format('MMMM');
const year = d.getFullYear();
const dateFormat = 'YYYYMM';

const startDate = new Date(d.getFullYear(), d.getMonth(), 1);
const endDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);

console.log('startDate', startDate, 'endDate', endDate);

const processCollectives = collectives => {
  return Promise.map(collectives, processCollective, { concurrency: 1 });
};

const init = async () => {
  const startTime = new Date();

  const query = {
    attributes: ['id', 'slug', 'name', 'twitterHandle', 'currency', 'settings', 'tags'],
    where: {
      type: { [Op.in]: ['COLLECTIVE', 'ORGANIZATION'] },
      isActive: true,
    },
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

  const collectives = await models.Collective.findAll(query);

  console.log(`Preparing the ${month} report for ${collectives.length} collectives`);

  processCollectives(collectives).then(() => {
    const timeLapsed = Math.round((new Date() - startTime) / 1000);
    console.log(`Total run time: ${timeLapsed}s`);
    process.exit(0);
  });
};

const processCollective = collective => {
  const promises = [
    collective.getTiersWithUsers({
      attributes: ['id', 'slug', 'name', 'image', 'firstDonation', 'lastDonation', 'totalDonations', 'tier'],
      until: endDate,
    }),
    collective.getBalance({ endDate }),
    collective.getTotalTransactions(startDate, endDate, 'donation'),
    collective.getTotalTransactions(startDate, endDate, 'expense'),
    collective.getExpenses(null, startDate, endDate),
    collective.getRelatedCollectives(3, 0, 'c."createdAt"', 'DESC'),
    collective.getBackersStats(startDate, endDate),
    collective.getNewOrders(startDate, endDate, { status: { [Op.or]: ['ACTIVE', 'PAID'] } }),
    collective.getCancelledOrders(startDate, endDate),
    collective.getUpdates('published', startDate, endDate),
    collective.getNextGoal(endDate),
    collective.getTransactions({ startDate, endDate }),
  ];

  let emailData = {};
  const options = {};
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
      return getTiersStats(results[0], startDate, endDate).then(res => {
        data.collective = pick(collective, ['id', 'name', 'slug', 'currency', 'publicUrl']);
        data.collective.tiers = res.tiers.map(tier => ({
          ...tier.info,
          amountStr: tier.amountStr,
          activeBackers: tier.activeBackers,
        }));
        data.collective.backers = res.backers;
        data.collective.stats = results[6];
        data.collective.newOrders = results[7];
        data.collective.cancelledOrders = results[8];
        data.collective.stats.balance = results[1];
        data.collective.stats.totalDonations = results[2];
        data.collective.stats.totalExpenses = results[3];
        data.collective.expenses = results[4].map(expense => expense.info);
        data.relatedCollectives = results[5] || [];
        data.collective.updates = results[9].map(u => u.info);
        data.collective.transactions = results[11];
        const nextGoal = results[10];
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

          options.attachments = [
            {
              filename: csvFilename,
              content: csv,
            },
          ];
        }

        emailData = data;
        return collective;
      });
    })
    .then(async collective => {
      if (collective.type === 'ORGANIZATION') {
        const monthlyConsolidatedInvoices = await getConsolidatedInvoicePdfs(collective);

        if (!isEmpty(monthlyConsolidatedInvoices)) {
          options.attachments.push(...monthlyConsolidatedInvoices);
          emailData.consolidatedPdfs = true;
        }
      }
      const activity = {
        type: 'collective.monthlyreport',
        data: emailData,
      };
      return notifyAdminsOfCollective(collective.id, activity, options);
    })
    .catch(e => {
      console.error('Error in processing collective', collective.slug, e);
    });
};

init();
