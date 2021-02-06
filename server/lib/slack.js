/*
 * Slack message sending logic
 */

import config from 'config';
import Slack from 'node-slack';

import activitiesLib from '../lib/activities';

import logger from './logger';

export const OPEN_COLLECTIVE_SLACK_CHANNEL = {
  ABUSE: 'abuse',
};

export default {
  /*
   * Post a given activity to a public channel (meaning scrubbed info only)
   */
  postActivityOnPublicChannel(activity, webhookUrl) {
    const message = activitiesLib.formatMessageForPublicChannel(activity, 'slack');
    return this.postMessage(message, webhookUrl);
  },

  /**
   * Post a message on Open Collective's Slack. Channel must be a valid key of
   * `config.slack.webhooks`. Use the `OPEN_COLLECTIVE_SLACK_CHANNEL` helper.
   */
  postMessageToOpenCollectiveSlack(message, channel) {
    const webhookUrl = config.slack.webhooks[channel];
    if (webhookUrl) {
      this.postMessage(message, webhookUrl);
    } else if (typeof webhookUrl === 'undefined') {
      logger.warn(`Unknown slack channel ${channel}`);
    }
  },

  /*
   * Posts a message to a slack webhook
   */
  postMessage(msg, webhookUrl, options) {
    if (!options) {
      options = {};
    }

    if (options.linkTwitterMentions) {
      msg = msg.replace(/@([a-z\d_]+)/gi, '<http://twitter.com/$1|@$1>');
    }

    const slackOptions = {
      text: msg,
      username: 'OpenCollective',
      icon_url: 'https://opencollective.com/favicon.ico', // eslint-disable-line camelcase
      attachments: options.attachments || [],
    };

    return new Promise((resolve, reject) => {
      // production check
      if (config.env !== 'production' && !process.env.TEST_SLACK) {
        return resolve();
      }

      if (!slackOptions.text) {
        return resolve();
      }

      return new Slack(webhookUrl, {}).send(slackOptions, err => {
        if (err) {
          logger.warn(`SlackLib.postMessage failed for ${webhookUrl}:`, err);
          return reject(err);
        }
        return resolve();
      });
    });
  },
};
