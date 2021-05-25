import axios from 'axios';
import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import { get, remove } from 'lodash';

import { activities, channels } from '../constants';
import activityType from '../constants/activities';
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';
import activitiesLib from '../lib/activities';
import emailLib, { NO_REPLY_EMAIL } from '../lib/email';
import models from '../models';

import { getTransactionPdf } from './pdf';
import slackLib from './slack';
import twitter from './twitter';
import { parseToBoolean, toIsoDateStr } from './utils';
import { enrichActivity, sanitizeActivity } from './webhooks';

const debug = debugLib('notifications');

export default async activity => {
  notifyByEmail(activity).catch(console.log);

  // process notification entries for slack, twitter, gitter
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
    type: [activityType.ACTIVITY_ALL, activity.type],
    active: true,
  };

  const notificationChannels = await models.Notification.findAll({ where });
  return Promise.map(notificationChannels, notifConfig => {
    if (notifConfig.channel === channels.GITTER) {
      return publishToGitter(activity, notifConfig);
    } else if (notifConfig.channel === channels.SLACK) {
      return slackLib.postActivityOnPublicChannel(activity, notifConfig.webhookUrl);
    } else if (notifConfig.channel === channels.TWITTER) {
      return twitter.tweetActivity(activity);
    } else if (notifConfig.channel === channels.WEBHOOK) {
      return publishToWebhook(activity, notifConfig.webhookUrl);
    } else {
      return Promise.resolve();
    }
  }).catch(err => {
    console.error(
      `Error while publishing activity type ${activity.type} for collective ${activity.CollectiveId}`,
      activity,
      'error: ',
      err,
    );
  });
};

function shouldSkipActivity(activity) {
  if (activity.type === activityType.COLLECTIVE_TRANSACTION_CREATED) {
    if (parseToBoolean(config.activities?.skipTransactions)) {
      return true;
    } else if (!['CONTRIBUTION', 'ADDED_FUNDS'].includes(activity.data?.transaction?.kind)) {
      return true;
    }
  }

  return false;
}

function publishToGitter(activity, notifConfig) {
  const { message } = activitiesLib.formatMessageForPublicChannel(activity, 'markdown');
  if (message && config.env === 'production') {
    return axios.post(notifConfig.webhookUrl, { message });
  } else {
    Promise.resolve();
  }
}

function publishToWebhook(activity, webhookUrl) {
  if (slackLib.isSlackWebhookUrl(webhookUrl)) {
    return slackLib.postActivityOnPublicChannel(activity, webhookUrl);
  } else {
    const sanitizedActivity = sanitizeActivity(activity);
    const enrichedActivity = enrichActivity(sanitizedActivity);
    return axios.post(webhookUrl, enrichedActivity);
  }
}

/**
 * Send the notification email (using emailLib.sendMessageFromActivity)
 * to all users that have not unsubscribed
 * @param {*} users: [ { id, email, firstName, lastName }]
 * @param {*} activity [ { type, CollectiveId }]
 */
async function notifySubscribers(users, activity, options = {}) {
  const { data } = activity;
  if (!users || users.length === 0) {
    debug('notifySubscribers: no user to notify for activity', activity.type);
    return;
  }
  debug(
    'notifySubscribers',
    users.length,
    users.map(u => u && u.email, activity.type),
  );
  const unsubscribedUserIds = await models.Notification.getUnsubscribersUserIds(
    get(options, 'template', activity.type),
    get(options, 'collective.id', activity.CollectiveId),
  );
  debug('unsubscribedUserIds', unsubscribedUserIds);
  if (process.env.ONLY) {
    debug('ONLY set to ', process.env.ONLY, ' => skipping subscribers');
    return emailLib.send(options.template || activity.type, process.env.ONLY, data, options);
  }
  return Promise.all(
    users.map(u => {
      if (!u) {
        return;
      }
      // skip users that have unsubscribed
      if (unsubscribedUserIds.indexOf(u.id) === -1) {
        debug('sendMessageFromActivity', activity.type, 'UserId', u.id);
        return emailLib.send(options.template || activity.type, u.email, data, options);
      }
    }),
  );
}

async function notifyUserId(UserId, activity, options = {}) {
  const user = await models.User.findByPk(UserId);
  debug('notifyUserId', UserId, user && user.email, activity.type);

  if (activity.type === activityType.TICKET_CONFIRMED) {
    const event = await models.Collective.findByPk(activity.data.EventCollectiveId);
    const parentCollective = await event.getParentCollective();
    const ics = await event.getICS();
    options.attachments = [{ filename: `${event.slug}.ics`, content: ics }];

    const transaction = await models.Transaction.findOne({
      where: { OrderId: activity.data.order.id, type: TransactionTypes.CREDIT, kind: TransactionKind.CONTRIBUTION },
    });

    if (transaction) {
      const transactionPdf = await getTransactionPdf(transaction, user);
      if (transactionPdf) {
        const createdAtString = toIsoDateStr(transaction.createdAt ? new Date(transaction.createdAt) : new Date());
        options.attachments.push({
          filename: `transaction_${event.slug}_${createdAtString}_${transaction.uuid}.pdf`,
          content: transactionPdf,
        });
        activity.data.transactionPdf = true;
      }

      if (transaction.hasPlatformTip()) {
        const platformTipTransaction = await transaction.getPlatformTipTransaction();

        if (platformTipTransaction) {
          const platformTipPdf = await getTransactionPdf(platformTipTransaction, user);

          if (platformTipPdf) {
            const createdAtString = toIsoDateStr(new Date(platformTipTransaction.createdAt));
            options.attachments.push({
              filename: `transaction_opencollective_${createdAtString}_${platformTipTransaction.uuid}.pdf`,
              content: platformTipPdf,
            });
            activity.data.platformTipPdf = true;
          }
        }
      }
    }
    activity.data.event = event.info;
    activity.data.isOffline = activity.data.event.locationName !== 'Online';
    activity.data.collective = parentCollective.info;
    options.from = `${parentCollective.name} <no-reply@${parentCollective.slug}.opencollective.com>`;
  }

  return emailLib.send(activity.type, user.email, activity.data, options);
}

export async function notifyAdminsOfCollective(CollectiveId, activity, options = {}) {
  debug('notify admins of CollectiveId', CollectiveId);
  const collective = await models.Collective.findByPk(CollectiveId);
  if (!collective) {
    throw new Error(
      `notifyAdminsOfCollective> can't notify ${activity.type}: no collective found with id ${CollectiveId}`,
    );
  }
  let adminUsers = await collective.getAdminUsers();
  if (options.exclude) {
    adminUsers = adminUsers.filter(u => options.exclude.indexOf(u.id) === -1);
  }
  debug('Total users to notify:', adminUsers.length);
  activity.CollectiveId = collective.id;
  return notifySubscribers(adminUsers, activity, options);
}

/**
 * Notify all the followers of the conversation.
 */
export async function notifyConversationFollowers(conversation, activity, options = {}) {
  // Skip root comment as the notification is covered by the "New conversation" email
  if (conversation.RootCommentId === activity.data.comment.id) {
    return;
  }

  const toNotify = await conversation.getUsersFollowing();
  if (options.exclude) {
    remove(toNotify, user => options.exclude.indexOf(user.id) !== -1);
  }

  return notifySubscribers(toNotify, activity, options);
}

const notifyUpdateSubscribers = async activity => {
  if (activity.data.update?.isChangelog) {
    return;
  }
  const collective = await models.Collective.findByPk(activity.data.collective.id);
  activity.data.fromCollective = (await models.Collective.findByPk(activity.data.fromCollective.id))?.info;
  activity.data.collective = collective.info;
  activity.data.fromEmail = `${activity.data.collective.name} <no-reply@${activity.data.collective.slug}.opencollective.com>`;
  activity.CollectiveId = collective.id;

  const emailOpts = { from: activity.data.fromEmail };
  const update = await models.Update.findByPk(activity.data.update.id);
  const allUsers = await update.getUsersToNotify();
  const modifiedActivity = replaceVideosByImagePreviews(activity);
  return notifySubscribers(allUsers, modifiedActivity, emailOpts);
};

function replaceVideosByImagePreviews(activity) {
  const iframePreviewRegex = /<iframe\s[^>]*src="([^"]+)"[^>]*><\/iframe>/gi;
  activity.data.update.html = activity.data.update.html
    .replace(iframePreviewRegex, (_, href) => {
      const { service, id } = parseServiceLink(href);
      const imgSrc = constructPreviewImageURL(service, id);
      if (imgSrc) {
        return `<img src="${imgSrc}" alt="${service} content">`;
      } else {
        return '';
      }
    })
    .replace(new RegExp('</iframe><figcaption></figcaption></figure>', 'g'), '')
    .replace(new RegExp('width="100%" height="394"', 'g'), '');
  return activity;
}

function constructPreviewImageURL(service, id) {
  if (service === 'youtube') {
    return `https://img.youtube.com/vi/${id}/0.jpg`;
  } else if (service === 'anchorFm') {
    return `https://theme.zdassets.com/theme_assets/2009830/ed34a3258bf8d79c3db30e4269dd95052481fc50.png`;
  } else {
    return null;
  }
}

function parseServiceLink(videoLink) {
  const regexps = {
    youtube: new RegExp(
      '(?:https?://)?(?:www\\.)?youtu(?:\\.be/|be(-nocookie)?\\.com/\\S*(?:watch|embed)(?:(?:(?=/[^&\\s?]+(?!\\S))/)|(?:\\S*v=|v/)))([^&\\s?]+)',
      'i',
    ),
    anchorFm: /^(http|https)?:\/\/(www\.)?anchor\.fm\/([^/]+)(\/embed)?(\/episodes\/)?([^/]+)?\/?$/,
  };
  for (const service in regexps) {
    videoLink = videoLink.replace('/?showinfo=0', '');
    const matches = regexps[service].exec(videoLink);
    if (matches) {
      if (service === 'anchorFm') {
        const podcastName = matches[3];
        const episodeId = matches[6];
        const podcastUrl = `${podcastName}/embed`;
        return { service, id: episodeId ? `${podcastUrl}/episodes/${episodeId}` : podcastUrl };
      } else {
        return { service, id: matches[matches.length - 1] };
      }
    }
  }
  return {};
}

async function notifyByEmail(activity) {
  debug('notifyByEmail', activity.type);
  let collective, conversation;
  switch (activity.type) {
    case activityType.TICKET_CONFIRMED:
      notifyUserId(activity.data.UserId, activity);
      break;

    case activityType.ORGANIZATION_COLLECTIVE_CREATED:
      notifyUserId(activity.UserId, activity);
      break;

    case activityType.COLLECTIVE_UPDATE_PUBLISHED:
      twitter.tweetActivity(activity);
      notifyUpdateSubscribers(activity);
      break;

    case activityType.SUBSCRIPTION_CANCELED:
      return notifyUserId(activity.UserId, activity, {
        bcc: `no-reply@${activity.data.collective.slug}.opencollective.com`,
      });

    case activityType.COLLECTIVE_MEMBER_CREATED:
      twitter.tweetActivity(activity);
      notifyAdminsOfCollective(activity.data.collective.id, activity);
      break;

    case activityType.COLLECTIVE_EXPENSE_CREATED:
      notifyAdminsOfCollective(activity.CollectiveId, activity);
      break;

    case activityType.COLLECTIVE_CONTACT:
      notifyAdminsOfCollective(activity.data.collective.id, activity, { replyTo: activity.data.user.email });
      break;

    case activityType.COLLECTIVE_CONVERSATION_CREATED:
      activity.data.collective = await models.Collective.findByPk(activity.data.conversation.CollectiveId);
      activity.data.fromCollective = await models.Collective.findByPk(activity.data.conversation.FromCollectiveId);
      activity.data.rootComment = await models.Comment.findByPk(activity.data.conversation.RootCommentId);
      activity.data.collective = activity.data.collective?.info;
      activity.data.fromCollective = activity.data.fromCollective?.info;
      activity.data.rootComment = activity.data.rootComment?.info;
      notifyAdminsOfCollective(activity.data.conversation.CollectiveId, activity, { exclude: [activity.UserId] });
      break;
    case activityType.COLLECTIVE_COMMENT_CREATED:
      collective = await models.Collective.findByPk(activity.CollectiveId);
      activity.data.collective = collective.info;
      activity.data.fromCollective = await models.Collective.findByPk(activity.data.FromCollectiveId);
      activity.data.fromCollective = activity.data.fromCollective.info;

      if (activity.data.ConversationId) {
        conversation = await models.Conversation.findByPk(activity.data.ConversationId);
        activity.data.conversation = conversation.info;
        activity.data.UserId = get(activity.data.conversation, 'CreatedByUserId');
        activity.data.path = `/${activity.data.collective.slug}/conversations/${activity.data.conversation.slug}-${activity.data.conversation.hashId}`;

        notifyConversationFollowers(conversation, activity, {
          from: NO_REPLY_EMAIL,
          exclude: [activity.UserId], // Don't notify the person who commented
        });
      } else if (activity.data.ExpenseId) {
        activity.data.expense = await models.Expense.findByPk(activity.data.ExpenseId);
        activity.data.expense = activity.data.expense.info;
        activity.data.UserId = activity.data.expense.UserId;
        activity.data.path = `/${activity.data.collective.slug}/expenses/${activity.data.expense.id}`;

        // Notify the admins of the collective
        notifyAdminsOfCollective(activity.CollectiveId, activity, {
          from: NO_REPLY_EMAIL,
          exclude: [activity.UserId, activity.data.UserId], // Don't notify the person who commented nor the expense author
        });

        // Notify the admins of the host (if any)
        const HostCollectiveId = await collective.getHostCollectiveId();
        if (HostCollectiveId) {
          notifyAdminsOfCollective(HostCollectiveId, activity, {
            from: NO_REPLY_EMAIL,
            exclude: [activity.UserId, activity.data.UserId], // Don't notify the person who commented nor the expense author
          });
        }

        // Notify the author of the expense
        if (activity.UserId !== activity.data.UserId) {
          notifyUserId(activity.data.UserId, activity, {
            from: NO_REPLY_EMAIL,
          });
        }
      } else if (activity.data.UpdateId) {
        activity.data.update = await models.Update.findByPk(activity.data.UpdateId);
        activity.data.update = activity.data.update.info;
        activity.data.UserId = activity.data.update.CreatedByUserId;
        activity.data.path = `/${activity.data.collective.slug}/updates/${activity.data.update.slug}`;

        // Notify the admins of the collective
        notifyAdminsOfCollective(activity.CollectiveId, activity, {
          from: NO_REPLY_EMAIL,
          exclude: [activity.UserId], // Don't notify the person who commented
        });
      }

      break;

    case activityType.COLLECTIVE_EXPENSE_APPROVED:
      activity.data.actions = {
        viewLatestExpenses: `${config.host.website}/${activity.data.collective.slug}/expenses#expense${activity.data.expense.id}`,
      };
      activity.data.expense.payoutMethodLabel = models.PayoutMethod.getLabel(activity.data.payoutMethod);
      notifyUserId(activity.data.expense.UserId, activity, { from: NO_REPLY_EMAIL });
      // We only notify the admins of the host if the collective is active (ie. has been approved by the host)
      if (get(activity, 'data.host.id') && get(activity, 'data.collective.isActive')) {
        notifyAdminsOfCollective(activity.data.host.id, activity, {
          template: 'collective.expense.approved.for.host',
          collective: activity.data.host,
        });
      }
      break;

    case activityType.COLLECTIVE_EXPENSE_REJECTED:
      activity.data.actions = {
        viewLatestExpenses: `${config.host.website}/${activity.data.collective.slug}/expenses#expense${activity.data.expense.id}`,
      };
      notifyUserId(activity.data.expense.UserId, activity, { from: NO_REPLY_EMAIL });
      break;

    case activityType.COLLECTIVE_EXPENSE_PAID:
      activity.data.actions = {
        viewLatestExpenses: `${config.host.website}/${activity.data.collective.slug}/expenses#expense${activity.data.expense.id}`,
      };
      activity.data.expense.payoutMethodLabel = models.PayoutMethod.getLabel(activity.data.payoutMethod);
      notifyUserId(activity.data.expense.UserId, activity, { from: NO_REPLY_EMAIL });
      if (get(activity, 'data.host.id')) {
        notifyAdminsOfCollective(activity.data.host.id, activity, {
          template: 'collective.expense.paid.for.host',
          collective: activity.data.host,
        });
      }
      break;

    case activityType.COLLECTIVE_EXPENSE_ERROR:
      activity.data.actions = {
        viewLatestExpenses: `${config.host.website}/${activity.data.collective.slug}/expenses#expense${activity.data.expense.id}`,
      };
      notifyUserId(activity.data.expense.UserId, activity, { from: NO_REPLY_EMAIL });
      if (get(activity, 'data.host.id')) {
        notifyAdminsOfCollective(activity.data.host.id, activity, {
          template: 'collective.expense.error.for.host',
          collective: activity.data.host,
        });
      }
      break;

    case activityType.COLLECTIVE_EXPENSE_PROCESSING:
      activity.data.actions = {
        viewLatestExpenses: `${config.host.website}/${activity.data.collective.slug}/expenses#expense${activity.data.expense.id}`,
      };
      notifyUserId(activity.data.expense.UserId, activity, { from: NO_REPLY_EMAIL });
      break;

    case activityType.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT:
      break;

    case activityType.COLLECTIVE_APPROVED:
      // Funds MVP
      if (get(activity, 'data.collective.type') === 'FUND' || get(activity, 'data.collective.settings.fund') === true) {
        if (get(activity, 'data.host.slug') === 'foundation') {
          notifyAdminsOfCollective(activity.data.collective.id, activity, {
            template: 'fund.approved.foundation',
          });
        }
        break;
      }

      notifyAdminsOfCollective(activity.data.collective.id, activity);
      break;

    case activityType.COLLECTIVE_REJECTED:
      // Funds MVP
      if (get(activity, 'data.collective.type') === 'FUND' || get(activity, 'data.collective.settings.fund') === true) {
        break;
      }

      notifyAdminsOfCollective(
        activity.data.collective.id,
        activity,
        {
          template: 'collective.rejected',
        },
        { replyTo: `no-reply@${activity.data.host.slug}.opencollective.com` },
      );
      break;

    case activityType.COLLECTIVE_APPLY:
      notifyAdminsOfCollective(activity.data.host.id, activity, {
        template: 'collective.apply.for.host',
        replyTo: activity.data.user.email,
      });

      // Funds MVP, we assume the info is already sent in COLLECTIVE_CREATED
      if (get(activity, 'data.collective.type') === 'FUND' || get(activity, 'data.collective.settings.fund') === true) {
        break;
      }

      notifyAdminsOfCollective(activity.data.collective.id, activity, {
        from: `no-reply@${activity.data.host.slug}.opencollective.com`,
      });
      break;

    case activityType.COLLECTIVE_CREATED:
      // Funds MVP
      if (get(activity, 'data.collective.type') === 'FUND' || get(activity, 'data.collective.settings.fund') === true) {
        if (get(activity, 'data.host.slug') === 'foundation') {
          notifyAdminsOfCollective(activity.data.collective.id, activity, {
            template: 'fund.created.foundation',
          });
        }
        break;
      }

      // Disable for the-social-change-nest
      if (get(activity, 'data.host.slug') === 'the-social-change-nest') {
        break;
      }

      // Normal case
      notifyAdminsOfCollective(activity.data.collective.id, activity);
      break;

    case activityType.COLLECTIVE_CREATED_GITHUB:
      notifyAdminsOfCollective(activity.data.collective.id, activity, {
        template: 'collective.created.opensource',
      });
      break;

    case activityType.BACKYOURSTACK_DISPATCH_CONFIRMED:
      for (const order of activity.data.orders) {
        const collective = await models.Collective.findByPk(order.CollectiveId);
        order.collective = collective.info;
      }
      notifyAdminsOfCollective(activity.data.collective.id, activity, {
        template: 'backyourstack.dispatch.confirmed',
      });
      break;

    case activityType.ACTIVATED_COLLECTIVE_AS_HOST:
      notifyAdminsOfCollective(activity.data.collective.id, activity, {
        template: 'activated.collective.as.host',
      });
      break;

    case activityType.ACTIVATED_COLLECTIVE_AS_INDEPENDENT:
      notifyAdminsOfCollective(activity.data.collective.id, activity, {
        template: 'activated.collective.as.independent',
      });
      break;

    case activityType.DEACTIVATED_COLLECTIVE_AS_HOST:
      notifyAdminsOfCollective(activity.data.collective.id, activity, {
        template: 'deactivated.collective.as.host',
      });
      break;

    case activityType.COLLECTIVE_EXPENSE_INVITE_DRAFTED:
      // New User
      if (activity.data.payee?.email) {
        await emailLib.send(activity.type, activity.data.payee.email, activity.data, { sendEvenIfNotProduction: true });
      } else if (activity.data.payee.id) {
        await notifyAdminsOfCollective(activity.data.payee.id, activity, { sendEvenIfNotProduction: true });
      }
      break;

    case activityType.COLLECTIVE_EXPENSE_MISSING_RECEIPT:
      notifyAdminsOfCollective(activity.data.collective.id, activity, { sendEvenIfNotProduction: true });
      break;

    case activityType.VIRTUAL_CARD_REQUESTED:
      notifyAdminsOfCollective(activity.data.host.id, activity, {
        template: 'virtualcard.requested',
        replyTo: activity.data.user.email,
        sendEvenIfNotProduction: true,
      });
      break;

    case activityType.COLLECTIVE_VIRTUAL_CARD_ASSIGNED:
      notifyAdminsOfCollective(activity.CollectiveId, activity, {
        sendEvenIfNotProduction: true,
      });
      break;
  }
}
