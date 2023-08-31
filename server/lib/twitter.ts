import config from 'config';
import debugLib from 'debug';
import { IntlMessageFormat } from 'intl-messageformat';
import { get } from 'lodash';
import { TwitterApi } from 'twitter-api-v2';

import activityType from '../constants/activities';
import models from '../models';

import logger from './logger';
import { reportErrorToSentry, reportMessageToSentry } from './sentry';
import { formatCurrency } from './utils';

const debug = debugLib('twitter');

// We're only using `tweet.write`, but OAuth2 connection fails if `tweet.read` and `users.read` are not included
export const TWITTER_SCOPES = ['tweet.write', 'users.read', 'tweet.read'];

const tweetUpdate = async activity => {
  const tweet = twitterLib.compileTweet('updatePublished', { title: activity.data.update.title });
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

type TweetParams = Partial<Parameters<TwitterApi['v2']['tweet']>[0]>;

const getClientFromConnectedAccount = (twitterAccount): TwitterApi => {
  return new TwitterApi(twitterAccount.token);
};

const tweetStatus = async (
  twitterAccount,
  status,
  url = null,
  options: TweetParams = {},
): Promise<ReturnType<TwitterApi['v2']['tweet']>> => {
  // collectives without twitter credentials are ignored
  if (!twitterAccount) {
    debug('>>> tweetStatus: no twitter account connected');
    return;
  }

  if (url) {
    status += `\n${url}`;
  }

  debug('tweeting status: ', status, 'with options:', options);

  if (twitterAccount.clientId) {
    logger.debug(`Tweet not sent for ${twitterAccount.username}: Using legacy OAuth1.0 credentials`);
  } else if (!get(config, 'twitter.disable')) {
    try {
      const client = getClientFromConnectedAccount(twitterAccount);
      return client.v2.tweet(status, options);
    } catch (err) {
      reportErrorToSentry(err, { extra: { status, options } });
    }
  }
};

const compileTweet = (template, data, message = undefined) => {
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
    if (!tweet || tweet.length < 280 - 24 - thankyou.length) {
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
