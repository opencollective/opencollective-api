import config from 'config';
import debugLib from 'debug';
import { IntlMessageFormat } from 'intl-messageformat';
import { get, has } from 'lodash-es';
import Twitter from 'twitter';

import activityType from '../constants/activities.js';
import models from '../models/index.js';

import logger from './logger.js';
import { reportMessageToSentry } from './sentry.js';
import { formatCurrency } from './utils.js';

const debug = debugLib('twitter');

const tweetUpdate = async activity => {
  const tweet = twitterLib.compileTweet('updatePublished', {
    title: activity.data.update.title,
  });
  const twitterAccount = await models.ConnectedAccount.findOne({
    where: { CollectiveId: activity.CollectiveId, service: 'twitter' },
  });
  if (!twitterAccount) {
    debug('no twitter account associated to ', activity.CollectiveId);
    return;
  }
  twitterAccount.settings = twitterAccount.settings || {};
  const settings = twitterAccount.settings['updatePublished'] || {};
  if (!settings.active) {
    debug('updatePublished.active false', settings);
    return;
  }

  twitterLib.tweetStatus(twitterAccount, tweet, activity.data.url);
};

const tweetNewMember = async activity => {
  if (get(activity, 'data.member.role') !== 'BACKER') {
    debug('skipping', activity.type, get(activity, 'data.member.role'));
    return;
  }

  if (!get(activity, 'data.member.memberCollective.twitterHandle')) {
    debug('skipping', 'no twitter handle for ', get(activity, 'data.member.memberCollective.slug'));
    return;
  }

  const twitterAccount = await models.ConnectedAccount.findOne({
    where: { CollectiveId: activity.CollectiveId, service: 'twitter' },
  });
  if (!twitterAccount) {
    debug('no twitter account associated to ', activity.CollectiveId);
    return;
  }
  debug(twitterAccount.settings);
  twitterAccount.settings = twitterAccount.settings || {};
  const settings = twitterAccount.settings['newBacker'] || {};
  if (!settings.active) {
    debug('newBacker.active false', settings);
    return;
  }

  const template = settings.tweet;

  // todo: we should use the handlebar templating system to support {{#if}}{{/if}}
  const amount = get(activity, 'data.order.totalAmount') - get(activity, 'data.order.data.platformFee', 0);
  const status = template
    .replace('{backerTwitterHandle}', `@${get(activity, 'data.member.memberCollective.twitterHandle')}`)
    .replace('{amount}', formatCurrency(amount, get(activity, 'data.order.currency')));

  return await twitterLib.tweetStatus(
    twitterAccount,
    status,
    `https://opencollective.com/${get(activity, 'data.collective.slug')}`,
  );
};

const tweetActivity = async activity => {
  debug('>>> tweetActivity', activity.type);
  debug('>>> tweetActivity.data', JSON.stringify(activity.data));
  switch (activity.type) {
    case activityType.COLLECTIVE_MEMBER_CREATED:
      return tweetNewMember(activity);

    case activityType.COLLECTIVE_UPDATE_PUBLISHED:
      return tweetUpdate(activity);
  }
};

const tweetStatus = (twitterAccount, status, url, options = {}) => {
  // collectives without twitter credentials are ignored
  if (!twitterAccount) {
    debug('>>> tweetStatus: no twitter account connected');
    return;
  }

  if (url) {
    status += `\n${url}`;
  }

  debug('tweeting status: ', status, 'with options:', options);
  if (has(config, 'twitter.consumerKey') && has(config, 'twitter.consumerSecret')) {
    /* eslint-disable camelcase */
    const client = new Twitter({
      consumer_key: get(config, 'twitter.consumerKey'),
      consumer_secret: get(config, 'twitter.consumerSecret'),
      access_token_key: twitterAccount.clientId,
      access_token_secret: twitterAccount.token,
    });
    /* eslint-enable camelcase */

    return client.post('statuses/update', { status, ...options }).catch(err => {
      err = Array.isArray(err) ? err.shift() : err;
      logger.info(`Tweet not sent: ${err.message}`);
    });
  } else {
    logger.info('Tweet not sent: missing twitter consumerKey or consumerSecret configuration');
    return Promise.resolve();
  }
};

const compileTweet = (template, data, message) => {
  const messages = {
    'en-US': {
      tenBackers: `🎉 {collective} just reached 10 financial contributors! Thank you {topBackersTwitterHandles} 🙌
Support them too!`,
      fiftyBackers: `🎉 {collective} just reached 50 financial contributors!! 🙌
Support them too!`,
      oneHundred: `🎉 {collective} just reached 100 financial contributors!! 🙌
Support them too!`,
      oneThousandBackers: `🎉 {collective} just reached 1,000 financial contributors!!! 🙌
Support them too!`,
      updatePublished: 'Latest update from the collective: {title}',
      monthlyStats: `In {month}, {totalNewBackers, select,
  0 {we}
  1 {one new financial contributor joined. We}
  other {{totalNewBackers} {totalNewBackers, plural, one {financial contributor} other {financial contributors}} joined{newBackersTwitterHandlesCount, select, 0 {.} other { ({newBackersTwitterHandles}) - you are the best! 🙌}}

We}
} received {totalAmountReceived} from {totalActiveBackers} {totalActiveBackers, plural, one {financial contributor} other {financial contributors}}{totalAmountSpent, plural,
  =0 {.}
  other { and we spent {totalAmountSpent}.}} Our current balance is {balance}.{newBackersTwitterHandlesCount, select, 0 {} other {

Top financial contributors: {topBackersTwitterHandles}}}`,
      monthlyStatsNoNewDonation: `In {month}, we haven't received any new donation.

Our current balance is {balance}.

Become a financial contributor! 😃`,
    },
  };

  if (message) {
    messages['en-US'][template] = message;
  }

  if (!messages['en-US'][template]) {
    console.error('Invalid tweet template', template);
    reportMessageToSentry(`Invalid tweet template`, { extra: { template } });
    return;
  }

  const thankyou = '\n\nThank you! 🙏';
  const compiled = new IntlMessageFormat(messages['en-US'][template], 'en-US');
  let tweet = compiled.format(data);

  if (template === 'monthlyStats') {
    // A URL always takes 23 chars (+ space)
    if (tweet.length < 280 - 24 - thankyou.length) {
      tweet += thankyou;
    }
  }
  return tweet;
};

const twitterLib = {
  tweetActivity,
  tweetStatus,
  compileTweet,
};

export default twitterLib;
