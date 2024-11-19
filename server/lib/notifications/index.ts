import axios, { AxiosError } from 'axios';
import config from 'config';

import { activities, channels } from '../../constants';
import ActivityTypes from '../../constants/activities';
import { Activity, Notification } from '../../models';
import { reportErrorToSentry } from '../sentry';
import slackLib from '../slack';
import twitter from '../twitter';
import { parseToBoolean } from '../utils';
import { enrichActivity, sanitizeActivity } from '../webhooks';

import { notifyByEmail } from './email';

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

const publishToWebhook = async (notification: Notification, activity: Activity): Promise<boolean> => {
  if (slackLib.isSlackWebhookUrl(notification.webhookUrl)) {
    await slackLib.postActivityOnPublicChannel(activity, notification.webhookUrl);
    return true;
  } else {
    const sanitizedActivity = sanitizeActivity(activity);
    const enrichedActivity = enrichActivity(sanitizedActivity);
    const response = await axios.post(notification.webhookUrl, enrichedActivity, { maxRedirects: 0, timeout: 30000 });
    return response.status >= 200 && response.status < 300;
  }
};

const dispatch = async (
  activity: Activity,
  { onlyChannels = null, force = false, onlyAwaitEmails = false } = {},
): Promise<void> => {
  const shouldNotifyChannel = channel => !onlyChannels || onlyChannels.includes(channel);

  if (shouldNotifyChannel(channels.EMAIL)) {
    try {
      await notifyByEmail(activity);
    } catch (e) {
      if (!['ci', 'test', 'e2e'].includes(config.env)) {
        console.error(e);
      }
    }
  }

  const dispatchToOtherChannels = async () => {
    // process notification entries for slack, twitter, etc...
    if (!activity.CollectiveId || !activity.type) {
      return;
    }

    if (shouldSkipActivity(activity) && !force) {
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

    const notificationChannels = await Notification.findAll({ where });
    return Promise.all(
      notificationChannels.map(async notifConfig => {
        if (!shouldNotifyChannel(notifConfig.channel)) {
          return;
        }

        try {
          if (notifConfig.channel === channels.SLACK) {
            await slackLib.postActivityOnPublicChannel(activity, notifConfig.webhookUrl);
            notifConfig.recordSuccess(); // No need to await
          } else if (notifConfig.channel === channels.TWITTER) {
            await twitter.tweetActivity(activity);
            notifConfig.recordSuccess(); // No need to await
          } else if (notifConfig.channel === channels.WEBHOOK) {
            const success = await publishToWebhook(notifConfig, activity);
            if (success) {
              notifConfig.recordSuccess(); // No need to await
            }
          }
        } catch (e) {
          const stringifiedError =
            e instanceof AxiosError ? `${e.response?.status} ${e.response?.statusText} ${e.config?.url}` : e;
          if (e instanceof AxiosError) {
            e.message = `Error sending Activity notification`;
          }
          reportErrorToSentry(e, {
            tags: { notificationChannel: notifConfig.channel },
            extra: { activity, notifConfig, onlyChannels, force, stringifiedError },
          });
        }
      }),
    );
  };

  if (onlyAwaitEmails) {
    dispatchToOtherChannels();
  } else {
    await dispatchToOtherChannels();
  }
};

export default dispatch;
