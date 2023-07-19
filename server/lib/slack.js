/*
 * Slack message sending logic
 */

import axios from 'axios';
import config from 'config';

import activitiesLib from '../lib/activities.js';

import logger from './logger.js';
import { reportErrorToSentry } from './sentry.js';

export const OPEN_COLLECTIVE_SLACK_CHANNEL = {
  ABUSE: 'abuse',
};

// Mattermost is compatible with Slack webhooks
const KNOWN_MATTERMOST_INSTANCES = ['https://chat.diglife.coop/hooks/'];
const DISCORD_REGEX = /^https:\/\/discord(app)?\.com\/api\/webhooks\/.+$/;

export default {
  /*
   * Post a given activity to a public channel (meaning scrubbed info only)
   */
  postActivityOnPublicChannel(activity, webhookUrl) {
    const { message, options } = activitiesLib.formatMessageForPublicChannel(activity, 'slack');
    return this.postMessage(message, webhookUrl, options);
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
  async postMessage(msg, webhookUrl, options) {
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

    // production check
    if (config.env !== 'production' && !process.env.TEST_SLACK) {
      return;
    }

    if (!slackOptions.text) {
      return;
    }

    let targetUrl = webhookUrl;
    if (targetUrl.match(DISCORD_REGEX) && !targetUrl.match(/\/slack\/*$/)) {
      // Discord slack-compatible webhook - See https://discord.com/developers/docs/resources/webhook#execute-slackcompatible-webhook
      targetUrl = `${targetUrl.replace(/\/+$/, '')}/slack`;
    }

    try {
      return await axios.post(targetUrl, slackOptions);
    } catch (err) {
      logger.warn(`SlackLib.postMessage failed for ${targetUrl}:`, err);
      reportErrorToSentry(err, { extra: { targetUrl, slackOptions } });
      throw err;
    }
  },

  isSlackWebhookUrl(url) {
    if (url.startsWith('https://hooks.slack.com/')) {
      return true;
    } else if (url.match(DISCORD_REGEX)) {
      return true;
    }

    return KNOWN_MATTERMOST_INSTANCES.some(mattermostUrl => url.startsWith(mattermostUrl));
  },
};
