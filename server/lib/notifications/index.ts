import axios, { AxiosError } from 'axios';
import config from 'config';

import { activities, channels } from '../../constants/index.js';
import ActivityTypes from '../../constants/activities.js';
import models from '../../models/index.js';
import { Activity } from '../../models/Activity.js';
import { reportErrorToSentry } from '../sentry.js';
import slackLib from '../slack.js';
import twitter from '../twitter.js';
import { parseToBoolean } from '../utils.js';
import { enrichActivity, sanitizeActivity } from '../webhooks.js';

import { notifyByEmail } from './email.js';

const shouldSkipActivity = (activity: Activity) => {
  if (activity.type === ActivityTypes.COLLECTIVE_TRANSACTION_CREATED) {
    if (parseToBoolean(config.activities?.skipTransactions)) {
      return true;
    } else if (!['CONTRIBUTION', 'ADDED_FUNDS'].includes(activity.data?.transaction?.kind)) {
      return true;
    }
  }

  return false;
};

const publishToWebhook = (activity: Activity, webhookUrl: string) => {
  if (slackLib.isSlackWebhookUrl(webhookUrl)) {
    return slackLib.postActivityOnPublicChannel(activity, webhookUrl);
  } else {
    const sanitizedActivity = sanitizeActivity(activity);
    const enrichedActivity = enrichActivity(sanitizedActivity);
    return axios.post(webhookUrl, enrichedActivity, { maxRedirects: 0 });
  }
};

const dispatch = async (activity: Activity) => {
  notifyByEmail(activity).catch(console.log);

  // process notification entries for slack, twitter, etc...
  if (!activity.CollectiveId || !activity.type) {
    return;
  }

  if (shouldSkipActivity(activity)) {
    return;
  }

  // Some activities involve multiple collectives (eg. collective applying to a host)
  const collectiveIdsToNotify = [activity.CollectiveId];
  if (activity.type === activities.COLLECTIVE_APPLY) {
    collectiveIdsToNotify.push(activity.data.host.id);
  }

  const where = {
    CollectiveId: collectiveIdsToNotify,
    type: [ActivityTypes.ACTIVITY_ALL, activity.type],
    active: true,
  };

  const notificationChannels = await models.Notification.findAll({ where });
  return Promise.all(
    notificationChannels.map(notifConfig => {
      if (notifConfig.channel === channels.SLACK) {
        return slackLib.postActivityOnPublicChannel(activity, notifConfig.webhookUrl);
      } else if (notifConfig.channel === channels.TWITTER) {
        return twitter.tweetActivity(activity);
      } else if (notifConfig.channel === channels.WEBHOOK) {
        return publishToWebhook(activity, notifConfig.webhookUrl);
      }
    }),
  ).catch(err => {
    reportErrorToSentry(err);
    const stringifiedError =
      err instanceof AxiosError ? `${err.response?.status} ${err.response?.statusText} ${err.config?.url}` : err;
    console.error(
      `Error while publishing activity type ${activity.type} for collective ${activity.CollectiveId}`,
      activity,
      'error: ',
      stringifiedError,
    );
  });
};

export default dispatch;
