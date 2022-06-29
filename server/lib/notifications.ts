import axios from 'axios';
import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import { get, remove } from 'lodash';
import sanitizeHtml from 'sanitize-html';

import { activities, channels, roles } from '../constants';
import ActivityTypes from '../constants/activities';
import { types as CollectiveType } from '../constants/collectives';
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';
import models from '../models';
import Activity from '../models/Activity';
import { sanitizerOptions as updateSanitizerOptions } from '../models/Update';

import activitiesLib from './activities';
import emailLib, { NO_REPLY_EMAIL } from './email';
import { getTransactionPdf } from './pdf';
import { reportErrorToSentry } from './sentry';
import slackLib from './slack';
import twitter from './twitter';
import { parseToBoolean, toIsoDateStr } from './utils';
import { enrichActivity, sanitizeActivity } from './webhooks';

const debug = debugLib('notifications');

export default async (activity: Activity) => {
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
    type: [ActivityTypes.ACTIVITY_ALL, activity.type],
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
    reportErrorToSentry(err);
    console.error(
      `Error while publishing activity type ${activity.type} for collective ${activity.CollectiveId}`,
      activity,
      'error: ',
      err,
    );
  });
};

function shouldSkipActivity(activity: Activity) {
  if (activity.type === ActivityTypes.COLLECTIVE_TRANSACTION_CREATED) {
    if (parseToBoolean(config.activities?.skipTransactions)) {
      return true;
    } else if (!['CONTRIBUTION', 'ADDED_FUNDS'].includes(activity.data?.transaction?.kind)) {
      return true;
    }
  }

  return false;
}

function publishToGitter(activity: Activity, notifConfig) {
  const { message } = activitiesLib.formatMessageForPublicChannel(activity, 'markdown');
  if (message && config.env === 'production') {
    return axios.post(notifConfig.webhookUrl, { message }, { maxRedirects: 0 });
  } else {
    Promise.resolve();
  }
}

function publishToWebhook(activity: Activity, webhookUrl: string) {
  if (slackLib.isSlackWebhookUrl(webhookUrl)) {
    return slackLib.postActivityOnPublicChannel(activity, webhookUrl);
  } else {
    const sanitizedActivity = sanitizeActivity(activity);
    const enrichedActivity = enrichActivity(sanitizedActivity);
    return axios.post(webhookUrl, enrichedActivity, { maxRedirects: 0 });
  }
}

type NotifySubscribersOptions = {
  template?: string;
  from?: string;
  replyTo?: string;
  bcc?: string;
  collective?: typeof models.Collective;
  sendEvenIfNotProduction?: boolean;
};

/**
 * Send the notification email (using emailLib.sendMessageFromActivity)
 * to all users that have not unsubscribed
 * @param {*} users: [ { id, email }]
 * @param {*} activity [ { type, CollectiveId }]
 */
async function notifySubscribers(users, activity: Partial<Activity>, options: NotifySubscribersOptions = {}) {
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

async function notifyUserId(
  UserId: number,
  activity: Partial<Activity>,
  options: NotifySubscribersOptions & { attachments?: any[]; to?: string } = {},
) {
  const user = await models.User.findByPk(UserId);
  debug('notifyUserId', UserId, user && user.email, activity.type);

  if (activity.type === ActivityTypes.TICKET_CONFIRMED) {
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

  return emailLib.send(activity.type, options.to || user.email, activity.data, options);
}

export async function notifyAdminsOfCollective(
  CollectiveId: number,
  activity: Partial<Activity>,
  options: NotifySubscribersOptions & { exclude?: number[] } = {},
) {
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
  activity['CollectiveId'] = collective.id;
  return notifySubscribers(adminUsers, activity, options);
}

export async function notifyAdminsAndAccountantsOfCollective(
  CollectiveId: number,
  activity: Partial<Activity>,
  options: NotifySubscribersOptions & { exclude?: number[] } = {},
) {
  debug('notify admins and accountants of CollectiveId', CollectiveId);
  const collective = await models.Collective.findByPk(CollectiveId);
  if (!collective) {
    throw new Error(
      `notifyAdminsAndAccountantsOfCollective> can't notify ${activity.type}: no collective found with id ${CollectiveId}`,
    );
  }

  let usersToNotify = [];
  if (collective.type === CollectiveType.USER && !collective.isIncognito) {
    // Incognito profiles rely on the `Members` entry to know which user it belongs to
    usersToNotify = [await collective.getUser()];
  } else {
    usersToNotify = await collective.getMembersUsers({
      CollectiveId: collective.ParentCollectiveId ? [collective.ParentCollectiveId, collective.id] : collective.id,
      role: [roles.ACCOUNTANT, roles.ADMIN],
    });
  }

  if (options.exclude) {
    usersToNotify = usersToNotify.filter(u => options.exclude.indexOf(u.id) === -1);
  }
  debug('Total users to notify:', usersToNotify.length);
  activity.CollectiveId = collective.id;
  return notifySubscribers(usersToNotify, activity, options);
}

/**
 * Notify all the followers of the conversation.
 */
export async function notifyConversationFollowers(
  conversation,
  activity: Partial<Activity>,
  options: NotifySubscribersOptions & { exclude?: number[] } = {},
) {
  // Skip root comment as the notification is covered by the "New conversation" email
  if (conversation.RootCommentId === activity.data.comment.id) {
    return;
  }

  const toNotify: { id: number }[] = await conversation.getUsersFollowing();
  if (options.exclude) {
    remove(toNotify, user => options.exclude.indexOf(user.id) !== -1);
  }

  return notifySubscribers(toNotify, activity, options);
}

const notifyUpdateSubscribers = async (activity: Partial<Activity>) => {
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

function replaceVideosByImagePreviews(activity: Partial<Activity>) {
  const sanitizerOptions = {
    ...updateSanitizerOptions,
    transformTags: {
      ...updateSanitizerOptions.transformTags,
      iframe: (tagName, attribs) => {
        if (!attribs.src) {
          return '';
        }
        const { service, id } = parseServiceLink(attribs.src);
        const imgSrc = constructPreviewImageURL(service, id);
        if (imgSrc) {
          return {
            tagName: 'img',
            attribs: {
              src: imgSrc,
              alt: `${service} content`,
            },
          };
        } else {
          return '';
        }
      },
    },
  };
  activity.data.update.html = sanitizeHtml(activity.data.update.html, sanitizerOptions);
  return activity;
}

function constructPreviewImageURL(service: string, id: string) {
  if (service === 'youtube' && id.match('[a-zA-Z0-9_-]{11}')) {
    return `https://img.youtube.com/vi/${id}/0.jpg`;
  } else if (service === 'anchorFm') {
    return `https://opencollective.com/static/images/anchor-fm-logo.png`;
  } else {
    return null;
  }
}

function parseServiceLink(videoLink: string) {
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

const populateCommentActivity = async activity => {
  const collective = await models.Collective.findByPk(activity.CollectiveId);
  activity.data.collective = collective.info;
  const fromCollective = await models.Collective.findByPk(activity.data.FromCollectiveId);
  activity.data.fromCollective = fromCollective.info;

  return { collective, fromCollective };
};

async function notifyByEmail(activity: Activity) {
  debug('notifyByEmail', activity.type);
  switch (activity.type) {
    case ActivityTypes.ORDER_PROCESSING:
      notifyUserId(activity.UserId, activity, {
        from: `${activity.data.collective.name} <no-reply@${activity.data.collective.slug}.opencollective.com>`,
      });
      break;

    case ActivityTypes.ORDER_PROCESSING_CRYPTO:
      notifyUserId(activity.UserId, activity, {
        from: `${activity.data.collective.name} <no-reply@${activity.data.collective.slug}.opencollective.com>`,
      });
      break;

    case ActivityTypes.USER_CARD_CLAIMED:
      notifyUserId(activity.UserId, activity);
      break;

    case ActivityTypes.PAYMENT_CREDITCARD_EXPIRING:
      notifyAdminsOfCollective(activity.data.CollectiveId, activity);
      break;

    case ActivityTypes.USER_CARD_INVITED:
      emailLib.send(activity.type, activity.data.email, activity.data);
      break;

    case ActivityTypes.COLLECTIVE_MEMBER_INVITED:
      notifyAdminsOfCollective(activity.data.memberCollective.id, activity, {
        template: 'member.invitation',
      });
      break;

    case ActivityTypes.VIRTUAL_CARD_CHARGE_DECLINED:
      if (activity.UserId) {
        notifyUserId(activity.UserId, activity);
      } else {
        notifyAdminsOfCollective(activity.CollectiveId, activity);
      }
      break;

    case ActivityTypes.TAXFORM_REQUEST:
      notifyUserId(activity.UserId, activity);
      break;

    case ActivityTypes.TICKET_CONFIRMED:
      notifyUserId(activity.data.UserId, activity);
      break;

    case ActivityTypes.ORGANIZATION_COLLECTIVE_CREATED:
      notifyUserId(activity.UserId, activity);
      break;

    case ActivityTypes.COLLECTIVE_UPDATE_PUBLISHED:
      twitter.tweetActivity(activity);
      notifyUpdateSubscribers(activity);
      break;

    case ActivityTypes.SUBSCRIPTION_CANCELED:
      return notifyUserId(activity.UserId, activity, {
        bcc: `no-reply@${activity.data.collective.slug}.opencollective.com`,
      });

    case ActivityTypes.COLLECTIVE_MEMBER_CREATED:
      twitter.tweetActivity(activity);
      notifyAdminsOfCollective(activity.data.collective.id, activity);
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_CREATED:
      notifyAdminsOfCollective(activity.CollectiveId, activity);
      break;

    case ActivityTypes.COLLECTIVE_CONTACT:
      notifyAdminsOfCollective(activity.data.collective.id, activity, { replyTo: activity.data.user.email });
      break;

    case ActivityTypes.COLLECTIVE_FROZEN:
    case ActivityTypes.COLLECTIVE_UNFROZEN:
      notifyAdminsOfCollective(activity.data.collective.id, activity);
      break;

    case ActivityTypes.COLLECTIVE_CONVERSATION_CREATED:
      activity.data.collective = await models.Collective.findByPk(activity.data.conversation.CollectiveId);
      activity.data.fromCollective = await models.Collective.findByPk(activity.data.conversation.FromCollectiveId);
      activity.data.rootComment = await models.Comment.findByPk(activity.data.conversation.RootCommentId);
      activity.data.collective = activity.data.collective?.info;
      activity.data.fromCollective = activity.data.fromCollective?.info;
      activity.data.rootComment = activity.data.rootComment?.info;
      notifyAdminsOfCollective(activity.data.conversation.CollectiveId, activity, { exclude: [activity.UserId] });
      break;

    case ActivityTypes.CONVERSATION_COMMENT_CREATED: {
      await populateCommentActivity(activity);
      const conversation = await models.Conversation.findByPk(activity.data.ConversationId);
      activity.data.conversation = conversation.info;
      activity.data.UserId = get(activity.data.conversation, 'CreatedByUserId');
      activity.data.path = `/${activity.data.collective.slug}/conversations/${activity.data.conversation.slug}-${activity.data.conversation.hashId}`;

      notifyConversationFollowers(conversation, activity, {
        from: NO_REPLY_EMAIL,
        exclude: [activity.UserId], // Don't notify the person who commented
      });
      break;
    }

    case ActivityTypes.UPDATE_COMMENT_CREATED: {
      await populateCommentActivity(activity);
      activity.data.update = await models.Update.findByPk(activity.data.UpdateId);
      activity.data.update = activity.data.update.info;
      activity.data.UserId = activity.data.update.CreatedByUserId;
      activity.data.path = `/${activity.data.collective.slug}/updates/${activity.data.update.slug}`;

      // Notify the admins of the collective
      notifyAdminsOfCollective(activity.CollectiveId, activity, {
        from: NO_REPLY_EMAIL,
        exclude: [activity.UserId], // Don't notify the person who commented
      });
      break;
    }

    case ActivityTypes.EXPENSE_COMMENT_CREATED: {
      const { collective } = await populateCommentActivity(activity);
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
      break;
    }

    case ActivityTypes.COLLECTIVE_EXPENSE_APPROVED:
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

    case ActivityTypes.COLLECTIVE_EXPENSE_REJECTED:
      activity.data.actions = {
        viewLatestExpenses: `${config.host.website}/${activity.data.collective.slug}/expenses#expense${activity.data.expense.id}`,
      };
      notifyUserId(activity.data.expense.UserId, activity, { from: NO_REPLY_EMAIL });
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_PAID:
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

    case ActivityTypes.COLLECTIVE_EXPENSE_ERROR:
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

    case ActivityTypes.COLLECTIVE_EXPENSE_PROCESSING:
      activity.data.actions = {
        viewLatestExpenses: `${config.host.website}/${activity.data.collective.slug}/expenses#expense${activity.data.expense.id}`,
      };
      notifyUserId(activity.data.expense.UserId, activity, { from: NO_REPLY_EMAIL });
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT:
      break;

    case ActivityTypes.COLLECTIVE_APPROVED:
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

    case ActivityTypes.COLLECTIVE_REJECTED:
      // Funds MVP
      if (get(activity, 'data.collective.type') === 'FUND' || get(activity, 'data.collective.settings.fund') === true) {
        break;
      }
      notifyAdminsOfCollective(activity.data.collective.id, activity, {
        template: 'collective.rejected',
        replyTo: `no-reply@${activity.data.host.slug}.opencollective.com`,
      });
      break;

    case ActivityTypes.COLLECTIVE_APPLY:
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

    case ActivityTypes.COLLECTIVE_CREATED:
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

    case ActivityTypes.COLLECTIVE_CREATED_GITHUB:
      notifyAdminsOfCollective(activity.data.collective.id, activity, {
        template: 'collective.created.opensource',
      });
      notifyUserId(activity.UserId, activity, {
        template: 'github.signup',
      });
      break;

    case ActivityTypes.BACKYOURSTACK_DISPATCH_CONFIRMED:
      for (const order of activity.data.orders) {
        const collective = await models.Collective.findByPk(order.CollectiveId);
        order.collective = collective.info;
      }
      notifyAdminsOfCollective(activity.data.collective.id, activity, {
        template: 'backyourstack.dispatch.confirmed',
      });
      break;

    case ActivityTypes.ACTIVATED_COLLECTIVE_AS_HOST:
      notifyAdminsOfCollective(activity.data.collective.id, activity, {
        template: 'activated.collective.as.host',
      });
      break;

    case ActivityTypes.ACTIVATED_COLLECTIVE_AS_INDEPENDENT:
      notifyAdminsOfCollective(activity.data.collective.id, activity, {
        template: 'activated.collective.as.independent',
      });
      break;

    case ActivityTypes.DEACTIVATED_COLLECTIVE_AS_HOST:
      notifyAdminsOfCollective(activity.data.collective.id, activity, {
        template: 'deactivated.collective.as.host',
      });
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_INVITE_DRAFTED:
      // New User
      if (activity.data.payee?.email) {
        const collectiveId = activity.data.user?.id; // TODO: It's confusing that we store a collective ID in `data.user.id`, should rather be a User id
        const sender = collectiveId && (await models.User.findOne({ where: { CollectiveId: collectiveId } }));
        await emailLib.send(activity.type, activity.data.payee.email, activity.data, {
          sendEvenIfNotProduction: true,
          replyTo: sender?.email,
        });
      } else if (activity.data.payee.id) {
        await notifyAdminsOfCollective(activity.data.payee.id, activity, { sendEvenIfNotProduction: true });
      }
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_RECURRING_DRAFTED:
      await notifyAdminsOfCollective(activity.data.payee.id, activity, { sendEvenIfNotProduction: true });
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_MISSING_RECEIPT:
      notifyAdminsOfCollective(activity.data.collective.id, activity, { sendEvenIfNotProduction: true });
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE:
      notifyAdminsOfCollective(activity.data.fromCollective.id, activity, { sendEvenIfNotProduction: true });
      break;

    case ActivityTypes.COLLECTIVE_VIRTUAL_CARD_MISSING_RECEIPTS:
      notifyAdminsOfCollective(activity.data.collective.id, activity, { sendEvenIfNotProduction: true });
      break;

    case ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED:
      notifyAdminsOfCollective(activity.data.collective.id, activity, { sendEvenIfNotProduction: true });
      notifyAdminsOfCollective(activity.data.host.id, activity, { sendEvenIfNotProduction: true });
      break;

    case ActivityTypes.VIRTUAL_CARD_REQUESTED:
      notifyAdminsOfCollective(activity.data.host.id, activity, {
        template: 'virtualcard.requested',
        replyTo: activity.data.user.email,
        sendEvenIfNotProduction: true,
      });
      break;

    case ActivityTypes.COLLECTIVE_VIRTUAL_CARD_ADDED:
      notifyAdminsOfCollective(activity.CollectiveId, activity, {
        sendEvenIfNotProduction: true,
      });
      break;

    default:
      break;
  }
}
