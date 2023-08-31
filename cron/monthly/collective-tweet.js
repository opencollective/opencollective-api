#!/usr/bin/env node
import '../../server/env';

import config from 'config';
import debugLib from 'debug';
import _, { get, pick, set } from 'lodash';
import moment from 'moment';

import { reportErrorToSentry } from '../../server/lib/sentry';
import twitter from '../../server/lib/twitter';
import models from '../../server/models';

// Only run on the first of the month
const today = new Date();
if (config.env === 'production' && today.getDate() !== 1) {
  console.log('OC_ENV is production and today is not the first of month, script aborted!');
  process.exit();
}

process.env.PORT = 3066;

const d = new Date();
d.setMonth(d.getMonth() - 1);
const month = moment(d).format('MMMM');

const startDate = new Date(d.getFullYear(), d.getMonth(), 1);
const endDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);

console.log('startDate', startDate, 'endDate', endDate);

const debug = debugLib('monthlyreport');

const init = async () => {
  const startTime = new Date();

  const query = {
    where: { service: 'twitter' },
    include: [
      {
        model: models.Collective,
        as: 'collective',
        required: true,
        where: { type: 'COLLECTIVE', isActive: true },
      },
    ],
  };

  if (process.env.SLUG) {
    query.include[0].where.slug = process.env.SLUG;
  }

  const connectedAccounts = await models.ConnectedAccount.findAll(query);

  console.log(`Preparing the ${month} report for ${connectedAccounts.length} collectives`);

  Promise.all(
    connectedAccounts.map(connectedAccount => {
      const collective = connectedAccount.collective;
      collective.twitterAccount = connectedAccount;
      return processCollective(collective);
    }),
  ).then(() => {
    const timeLapsed = Math.round((new Date() - startTime) / 1000);
    console.log(`Total run time: ${timeLapsed}s`);
    process.exit(0);
  });
};

function getLocaleFromCurrency(currency) {
  let locale;
  switch (currency) {
    case 'USD':
      locale = 'en-US';
      break;
    case 'EUR':
      locale = 'en-EU';
      break;
    default:
      locale = currency;
  }
  return locale;
}

const formatCurrency = (amount, currency) => {
  return (amount / 100).toLocaleString(getLocaleFromCurrency(currency), {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
};

const processCollective = collective => {
  const settings = get(collective, 'twitterAccount.settings.monthlyStats');
  if (!settings || !settings.active) {
    return;
  } else {
    console.log('>>> processing collective', collective.slug);
  }
  // for testing:
  // if (['material-ui', 'dim', 'electricsheep'].indexOf(collective.slug) === -1) return;

  const promises = [
    collective.getTopBackers(null, null, 10),
    collective.getTopBackers(startDate, endDate, 10),
    collective.getBalance({ endDate }),
    collective.getTotalTransactions(startDate, endDate, 'donation', 'amount'),
    collective.getTotalTransactions(startDate, endDate, 'expense', 'amount'),
    collective.getBackersStats(startDate, endDate),
    collective.getBackersCount({ since: startDate, until: endDate }),
  ];

  return Promise.all(promises)
    .then(results => {
      console.log('***', collective.slug, '***');
      const data = { month, year: startDate.getFullYear() };
      data.topBackers = results[0].map(b => pick(b.dataValues, ['slug', 'twitterHandle', 'totalDonations', 'role']));
      data.topNewBackers = results[1].map(b => pick(b.dataValues, ['slug', 'twitterHandle', 'totalDonations', 'role']));
      data.collective = pick(collective, ['id', 'name', 'slug', 'currency', 'publicUrl']);
      data.collective.stats = results[5];
      data.collective.stats.backers.totalActive = results[6];
      data.collective.stats.balance = results[2];
      data.collective.stats.totalReceived = results[3];
      data.collective.stats.totalSpent = results[4];
      return data;
    })
    .then(data => sendTweet(collective.twitterAccount, data))
    .catch(e => {
      console.error('Error in processing collective', collective.slug, e);
      reportErrorToSentry(e);
    });
};

const compileTwitterHandles = (userCollectives, total, limit) => {
  const twitterHandles = userCollectives.map(backer => backer.twitterHandle).filter(handle => Boolean(handle));
  const limitToShow = Math.min(twitterHandles.length, limit);
  if (!twitterHandles.length) {
    return { count: 0, str: '' };
  }

  let res = _.uniq(twitterHandles)
    .map(handle => `@${handle}`)
    .slice(0, limitToShow)
    .join(', ');
  if (limitToShow < total) {
    res += `, +${total - limitToShow}`;
  }
  return { count: Math.min(total, limitToShow), str: res };
};

const sendTweet = async (twitterAccount, data) => {
  const stats = data.collective.stats;
  const topBackersTwitterResult = compileTwitterHandles(data.topBackers, 0, 3);
  const newBackersTwitterResult = compileTwitterHandles(data.topNewBackers, stats.backers.new, 5);

  const replacements = {
    ...pick(data, ['month', 'year']),
    collectiveUrl: `https://opencollective.com/${data.collective.slug}`,
    totalNewBackers: stats.backers.new,
    totalBackers: stats.backers.lastMonth,
    totalActiveBackers: stats.backers.totalActive,
    balance: formatCurrency(Math.abs(stats.balance), data.collective.currency),
    totalAmountSpent:
      Math.abs(stats.totalSpent) > 0 ? formatCurrency(Math.abs(stats.totalSpent), data.collective.currency) : 0,
    totalAmountReceived: formatCurrency(stats.totalReceived, data.collective.currency),
    topBackersTwitterHandles: topBackersTwitterResult.str,
    topBackersTwitterHandlesCount: topBackersTwitterResult.count,
    newBackersTwitterHandles: newBackersTwitterResult.str,
    newBackersTwitterHandlesCount: newBackersTwitterResult.count,
  };

  const template = stats.totalReceived === 0 ? 'monthlyStatsNoNewDonation' : 'monthlyStats';
  const tweet = twitter.compileTweet(template, replacements);
  try {
    const res = await twitter.tweetStatus(twitterAccount, tweet, `https://opencollective.com/${data.collective.slug}`, {
      // We thread the tweet with the previous monthly stats
      reply: {
        // eslint-disable-next-line camelcase
        in_reply_to_tweet_id: get(twitterAccount, 'settings.monthlyStats.lastTweetId'),
      },
    });
    set(twitterAccount, 'settings.monthlyStats.lastTweetId', res.id_str);
    set(twitterAccount, 'settings.monthlyStats.lastTweetSentAt', new Date(res.created_at));
    twitterAccount.save();
    console.log('>>> sending tweet:', tweet.length);
    if (process.env.DEBUG) {
      console.log('>>> twitter response: ', JSON.stringify(res));
    }
    debug(replacements);
    console.log(tweet);
  } catch (e) {
    console.error('Unable to tweet', tweet, e);
    reportErrorToSentry(e);
  }
};

init();
