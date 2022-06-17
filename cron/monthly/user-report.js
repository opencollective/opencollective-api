#!/usr/bin/env node
import '../../server/env';

import fs from 'fs';
import path from 'path';

import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import { groupBy, isEmpty, pick, uniq } from 'lodash';
import moment from 'moment';

import ORDER_STATUS from '../../server/constants/order_status';
import roles from '../../server/constants/roles';
import emailLib from '../../server/lib/email';
import { getConsolidatedInvoicePdfs } from '../../server/lib/pdf';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { formatCurrencyObject, parseToBoolean } from '../../server/lib/utils';
import models, { Op } from '../../server/models';

if (parseToBoolean(process.env.SKIP_USER_REPORT) && !process.env.OFFCYCLE) {
  console.log('Skipping because SKIP_USER_REPORT is set.');
  process.exit();
}

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

const startDate = new Date(d.getFullYear(), d.getMonth(), 1);
const endDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);

console.log('startDate', startDate, 'endDate', endDate);

const debug = debugLib('monthlyreport');

/**
 * Returns the list of Users that are subscribed to the user.monthlyreport
 * for the current backer collective (User/Org/Collective)
 * @param {*} backerCollective
 */
const fetchUserSubscribers = async (notificationType, backerCollective) => {
  const unsubscriptions = await models.Notification.findAll({
    attributes: ['UserId'],
    where: {
      CollectiveId: backerCollective.id,
      type: notificationType,
      active: false,
    },
  });
  const unsubscribedUserIds = unsubscriptions.map(n => n.UserId);
  console.log(
    `${unsubscribedUserIds.length} users have unsubscribed from the ${notificationType} report for ${backerCollective.type} ${backerCollective.slug}`,
  );

  const admins = await backerCollective.getAdminUsers();
  const subscribers = admins.filter(a => a && unsubscribedUserIds.indexOf(a.id) === -1);

  return subscribers;
};

const init = async () => {
  const startTime = new Date();
  const query = {
    attributes: ['FromCollectiveId'],
    where: {
      type: 'CREDIT',
      OrderId: { [Op.ne]: null }, // make sure we don't consider collectives paying out expenses as backers of user collectives
      RefundTransactionId: null, // make sure we don't consider refunds
      createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
    },
    include: [
      {
        model: models.Collective,
        as: 'collective',
        where: { type: 'COLLECTIVE' },
      },
    ],
  };

  let FromCollectiveIds;
  if (process.env.SLUGS) {
    const slugs = process.env.SLUGS.split(',');
    const res = await models.Collective.findAll({
      attributes: ['id'],
      where: { slug: { [Op.in]: slugs } },
    });
    FromCollectiveIds = res.map(r => r.id);
  } else if (process.env.DEBUG && process.env.DEBUG.match(/preview/)) {
    FromCollectiveIds = [21272, 20568, 1729, 12671]; // fcb-event-user, fcb-event-anonymous, xdamman, coinbase
  } else {
    const transactions = await models.Transaction.findAll(query);
    FromCollectiveIds = uniq(transactions.map(t => t.FromCollectiveId));
  }

  console.log(`Preparing the ${month} report for ${FromCollectiveIds.length} backers`);
  await Promise.each(FromCollectiveIds, processBacker);

  const timeLapsed = Math.round((new Date() - startTime) / 1000);
  console.log(`Total run time: ${timeLapsed}s`);
  process.exit(0);
};

const processBacker = async FromCollectiveId => {
  const backerCollective = await models.Collective.findByPk(FromCollectiveId);
  console.log('>>> Processing backer', backerCollective.slug);
  const query = {
    attributes: ['CollectiveId', 'HostCollectiveId'],
    where: {
      FromCollectiveId,
      type: 'CREDIT',
      createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
    },
    include: [
      {
        model: models.Collective,
        as: 'collective',
        where: { type: 'COLLECTIVE' },
      },
    ],
  };
  const transactions = await models.Transaction.findAll(query);
  console.log('>>> transactions found', transactions.length);
  const distinctTransactions = [],
    collectiveIds = {};
  transactions.map(t => {
    if (!collectiveIds[t.CollectiveId]) {
      collectiveIds[t.CollectiveId] = true;
      distinctTransactions.push(t);
    }
  });

  if (distinctTransactions.length === 0) {
    console.log('>>> no transaction for', backerCollective.slug);
    return;
  }

  console.log(`>>> Collective ${FromCollectiveId} has backed ${distinctTransactions.length} collectives`);
  const collectives = await Promise.map(distinctTransactions, transaction =>
    processCollective(transaction.CollectiveId),
  );
  const subscribers = await fetchUserSubscribers('user.monthlyreport', backerCollective);
  console.log(`>>> Collective ${FromCollectiveId} has ${subscribers.length} subscribers`);

  if (subscribers.length === 0) {
    console.log('>>> no subscriber');
    return;
  }

  const orders = await models.Order.findAll({
    attributes: ['id', 'CollectiveId', 'totalAmount', 'currency'],
    where: {
      FromCollectiveId,
      [Op.or]: {
        createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
        SubscriptionId: { [Op.ne]: null },
      },
      status: {
        [Op.in]: [ORDER_STATUS.PAID, ORDER_STATUS.ACTIVE],
      },
      deletedAt: null,
    },
    include: [{ model: models.Subscription }],
  });
  // group orders(by collective) that either don't have subscription or have active subscription
  const ordersByCollectiveId = groupBy(
    orders.filter(o => !o.Subscription || o.Subscription.isActive),
    'CollectiveId',
  );
  const collectivesWithOrders = [];
  collectives.map(collective => {
    if (ordersByCollectiveId[collective.id]) {
      collectivesWithOrders.push({
        ...collective,
        orders: ordersByCollectiveId[collective.id].map(order => order.info),
        order: computeOrderSummary(ordersByCollectiveId[collective.id]),
      });
    }
  });
  const stats = await computeStats(collectivesWithOrders);

  // monthlyConsolidatedInvoices is array of attachments
  const monthlyConsolidatedInvoices = await getConsolidatedInvoicePdfs(backerCollective);

  try {
    await Promise.each(subscribers, user => {
      const data = {
        config: { host: config.host },
        month,
        fromCollective: backerCollective.info,
        collectives: collectivesWithOrders,
        manageSubscriptionsUrl: `${config.host.website}/recurring-contributions`,
        stats,
        tags: stats.allTags || {},
        consolidatedPdfs: isEmpty(monthlyConsolidatedInvoices) ? null : true,
      };
      if (data.tags['open source']) {
        data.tags.opensource = true;
      }
      data[backerCollective.type] = true;
      const options = {
        attachments: monthlyConsolidatedInvoices,
      };
      return sendEmail(user, data, options);
    });
  } catch (e) {
    console.error(e);
    reportErrorToSentry(e);
  }
};

const now = new Date();
const processEvents = events => {
  const res = {
    upcoming: [],
    past: [],
  };

  events.forEach(event => {
    event.stats = { confirmed: 0, interested: 0 };
    event.members.forEach(member => {
      if (member.role === roles.FOLLOWER) {
        event.stats.interested++;
      }
    });
    event.orders.forEach(order => {
      if (order.processedAt !== null) {
        event.stats.confirmed++;
      }
    });

    if (new Date(event.startsAt) > now) {
      res.upcoming.push(event.info);
    } else {
      res.past.push(event.info);
    }
  });
  return res;
};

/**
 * Processes the stats of a given collective and keeps the result in memory cache
 * Returns collective data object with
 * {
 *   ...{'id', 'name', 'slug', 'website', 'image', 'description', 'currency','publicUrl', 'tags', 'backgroundImage', 'settings', 'totalDonations', 'contributorsCount'},
 *   stats: { balance, totalDonations, totalPaidExpenses, updates },
 *   contributorsCounts,
 *   yearlyIncome,
 *   expenses
 *   events
 *   updates
 *   nextGoal
 * }
 */
const collectivesData = {};
const processCollective = async CollectiveId => {
  if (collectivesData[CollectiveId]) {
    return collectivesData[CollectiveId];
  }

  const collective = await models.Collective.findByPk(CollectiveId);
  const promises = [
    collective.getBackersStats(startDate, endDate),
    collective.getBalance({ endDate }),
    collective.getTotalTransactions(startDate, endDate, 'donation'),
    collective.getTotalTransactions(startDate, endDate, 'expense'),
    collective.getExpenses(null, startDate, endDate),
    collective.getYearlyIncome(),
    models.Expense.findAll({
      where: {
        CollectiveId: collective.id,
        createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
      },
      limit: 3,
      order: [['id', 'DESC']],
      include: [models.User],
    }),
    collective.getEvents({
      where: { startsAt: { [Op.gte]: startDate } },
      order: [['startsAt', 'DESC']],
      include: [
        { model: models.Member, as: 'members' },
        { model: models.Order, as: 'orders' },
      ],
    }),
    models.Update.findAll({
      where: {
        CollectiveId: collective.id,
        publishedAt: { [Op.gte]: startDate, [Op.lt]: endDate },
      },
      order: [['createdAt', 'DESC']],
    }),
    collective.getNextGoal(endDate),
  ];

  const results = await Promise.all(promises);
  console.log('***', collective.name, '***');
  const data = {};
  data.collective = pick(collective, [
    'id',
    'name',
    'slug',
    'website',
    'image',
    'currency',
    'publicUrl',
    'tags',
    'backgroundImage',
    'settings',
    'totalDonations',
    'contributorsCount',
    'description',
  ]);
  data.collective.stats = results[0];
  data.collective.stats.balance = results[1];
  data.collective.stats.totalDonations = results[2];
  data.collective.stats.totalPaidExpenses = -results[3];
  data.collective.contributorsCount =
    collective.data && collective.data.githubContributors
      ? Object.keys(collective.data.githubContributors).length
      : data.collective.stats.backers.lastMonth;
  data.collective.yearlyIncome = results[5];
  data.collective.expenses = results[6].map(expense => expense.info);
  data.collective.events = processEvents(results[7]);
  data.collective.updates = results[8].map(update => update.info);
  data.collective.stats.updates = results[8].length;
  const nextGoal = results[9];
  if (nextGoal) {
    nextGoal.tweet = `🚀 ${collective.twitterHandle ? `@${collective.twitterHandle}` : collective.name} is at ${
      nextGoal.percentage
    } of their next goal: ${nextGoal.title}.\nJoin me in helping them get there! 🙌\nhttps://opencollective.com/${
      collective.slug
    }`;
    data.collective.nextGoal = nextGoal;
  }
  console.log(data.collective.stats);
  collectivesData[CollectiveId] = data.collective;
  return data.collective;
};

const computeOrderSummary = orders => {
  const orderSummary = {
    totalAmount: '',
    totalAmountPerCurrency: {},
    Subscription: null,
  };
  if (orders && orders.length > 0) {
    for (const order of orders) {
      orderSummary.totalAmountPerCurrency[order.currency] = orderSummary.totalAmountPerCurrency[order.currency] || 0;
      orderSummary.totalAmountPerCurrency[order.currency] += order.totalAmount;

      if (order.Subscription && order.Subscription.isActive) {
        orderSummary.Subscription = order.Subscription.dataValues;
      }
    }
  }

  orderSummary.totalAmount = formatCurrencyObject(orderSummary.totalAmountPerCurrency);
  return orderSummary;
};

const computeStats = async collectives => {
  const tagsIndex = {};
  const stats = {
    collectives: collectives.length,
    expenses: 0,
    totalSpentPerCurrency: {},
    totalDonatedPerCurrency: {},
  };
  collectives.forEach(collective => {
    const expenses = collective.expenses;
    if (collective.tags) {
      collective.tags.map(t => {
        tagsIndex[t] = tagsIndex[t] || 0;
        tagsIndex[t]++;
      });
    }
    if (collective.orders && collective.orders.length > 0) {
      for (const order of collective.orders) {
        stats.totalDonatedPerCurrency[order.currency] = stats.totalDonatedPerCurrency[order.currency] || 0;
        stats.totalDonatedPerCurrency[order.currency] += order.totalAmount;
      }
    }
    if (expenses && expenses.length > 0) {
      stats.expenses += expenses.length;
      expenses.forEach(expense => {
        stats.totalSpentPerCurrency[expense.currency] = stats.totalSpentPerCurrency[expense.currency] || 0;
        stats.totalSpentPerCurrency[expense.currency] += expense.amount;
      });
    }
  });
  stats.allTags = tagsIndex;
  stats.totalSpentString = formatCurrencyObject(stats.totalSpentPerCurrency);
  stats.totalDonatedString = formatCurrencyObject(stats.totalDonatedPerCurrency);
  console.log(`>>> Stats: ${JSON.stringify(stats, null, 2)}`);
  return stats;
};

const sendEmail = (recipient, data, options = {}) => {
  if (recipient.length === 0) {
    return;
  }
  data.recipient = recipient;
  if (process.env.ONLY && recipient.email !== process.env.ONLY) {
    debug('Skipping ', recipient.email);
    return Promise.resolve();
  }

  if (process.env.SEND_EMAIL_TO) {
    recipient.email = process.env.SEND_EMAIL_TO;
  }

  if (process.env.DEBUG && process.env.DEBUG.match(/preview/) && options.attachments) {
    options.attachments.map(attachment => {
      const filepath = path.resolve(`/tmp/${attachment.filename}`);
      fs.writeFileSync(filepath, attachment.content);
      console.log('>>> preview attachment', filepath);
    });
  }

  return emailLib.send('user.monthlyreport', recipient.email, data, options);
};

init();
