import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import { cloneDeep, compact, get } from 'lodash';

import { roles } from '../../constants';
import ActivityTypes, { TransactionalActivities } from '../../constants/activities';
import Channels from '../../constants/channels';
import { types as CollectiveType } from '../../constants/collectives';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import models, { Collective } from '../../models';
import { Activity } from '../../models/Activity';
import User from '../../models/User';
import emailLib from '../email';
import { getTransactionPdf } from '../pdf';
import twitter from '../twitter';
import { toIsoDateStr } from '../utils';

import { replaceVideosByImagePreviews } from './utils';

const debug = debugLib('notifications');

type NotifySubscribersOptions = {
  attachments?: any[];
  bcc?: string;
  cc?: string;
  collective?: Collective;
  exclude?: number[];
  from?: string;
  replyTo?: string;
  sendEvenIfNotProduction?: boolean;
  template?: string;
  to?: string;
  unsubscribed?: Array<User>;
};

export const notify = {
  /** Notifies a single user based on Activity.UserId, User instance or User id */
  async user(
    activity: Partial<Activity>,
    options?: NotifySubscribersOptions & {
      user?: User;
      userId?: number;
    },
  ) {
    const userId = options?.user?.id || options?.userId || activity.UserId;
    const user = options?.user || (await models.User.findByPk(userId, { include: [{ association: 'collective' }] }));

    // TODO We're not using the `unsubscribed` option here, we should
    const unsubscribed = await models.Notification.getUnsubscribers({
      type: activity.type,
      UserId: user.id,
      CollectiveId: options?.collective?.id || activity.CollectiveId,
    });

    const isTransactional = TransactionalActivities.includes(activity.type);
    const emailData = cloneDeep(activity.data || {});
    if (unsubscribed.length === 0) {
      debug('notifying.user', user.id, user && user.email, activity.type);

      // Add recipient name to data
      if (!emailData.recipientName) {
        user.collective = user.collective || (await user.getCollective());
        if (user.collective) {
          emailData.recipientCollective = user.collective.info;
          emailData.recipientName = user.collective.name || user.collective.legalName;
        }
      }

      return emailLib.send(options?.template || activity.type, options?.to || user.email, emailData, {
        ...options,
        isTransactional,
      });
    }
  },

  async users(users: Array<User>, activity: Partial<Activity>, options?: NotifySubscribersOptions) {
    const unsubscribed = await models.Notification.getUnsubscribers({
      type: activity.type,
      CollectiveId: options?.collective?.id || activity.CollectiveId,
      channel: Channels.EMAIL,
    });

    // Remove any possible null or empty user in the array
    const cleanUsersArray = compact(users);

    if (process.env.ONLY) {
      debug('ONLY set to ', process.env.ONLY, ' => skipping subscribers');
      const isTransactional = TransactionalActivities.includes(activity.type);
      return emailLib.send(options?.template || activity.type, process.env.ONLY, activity.data, {
        ...options,
        isTransactional,
      });
    } else if (cleanUsersArray.length > 0) {
      return Promise.all(
        cleanUsersArray
          // Filter out unsubscribed users
          .filter(user => {
            const isUnsubscribed = unsubscribed.some(unsubscribedUser => unsubscribedUser.id === user.id);
            const isExcluded = options?.exclude?.includes(user.id) || false;
            return !isUnsubscribed && !isExcluded;
          })
          .map(user => notify.user(activity, { ...options, unsubscribed, user })),
      );
    }
  },

  /** Notifies admins of Collective based on activity.CollectiveId, options.collective or options.collectiveId.
   *  Alternatively, other roles can also be notified using options.role.
   */
  async collective(
    activity: Partial<Activity>,
    options?: NotifySubscribersOptions & {
      collective?: Collective;
      collectiveId?: number;
      role?: Array<roles>;
    },
  ) {
    const collectiveId = options?.collectiveId || activity.CollectiveId;
    const collective = options?.collective || (await models.Collective.findByPk(collectiveId));
    const role = options?.role || [roles.ADMIN];
    if (!collective) {
      throw new Error(`notify.collective can't notify ${activity.type}: no collective found with id ${collectiveId}`);
    }

    const isNonIncognitoUser = collective.type === CollectiveType.USER && !collective.isIncognito;
    const users = isNonIncognitoUser
      ? [await collective.getUser()]
      : await collective.getMembersUsers({
          CollectiveId: collective.ParentCollectiveId ? [collective.ParentCollectiveId, collective.id] : collective.id,
          role,
        });

    return notify.users(users, activity, { ...options, collective });
  },
};

const populateCommentActivity = async activity => {
  const collective = await models.Collective.findByPk(activity.CollectiveId);
  activity.data.collective = collective.info;
  const fromCollective = await models.Collective.findByPk(activity.FromCollectiveId);
  activity.data.fromCollective = fromCollective.info;

  return { collective, fromCollective };
};

export const notifyByEmail = async (activity: Activity) => {
  debug('notifyByEmail', activity.type);
  switch (activity.type) {
    case ActivityTypes.COLLECTIVE_EXPENSE_CREATED:
    case ActivityTypes.COLLECTIVE_FROZEN:
    case ActivityTypes.COLLECTIVE_UNFROZEN:
    case ActivityTypes.PAYMENT_CREDITCARD_EXPIRING:
    case ActivityTypes.ORDER_PENDING_CREATED:
      await notify.collective(activity);
      break;

    case ActivityTypes.COLLECTIVE_UNHOSTED:
      await notify.collective(activity, {
        replyTo: activity.data.host.data?.replyToEmail || 'support@opencollective.com',
      });
      break;

    case ActivityTypes.OAUTH_APPLICATION_AUTHORIZED:
    case ActivityTypes.ORGANIZATION_COLLECTIVE_CREATED:
    case ActivityTypes.TAXFORM_REQUEST:
    case ActivityTypes.USER_CARD_CLAIMED:
      await notify.user(activity);
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_MISSING_RECEIPT:
    case ActivityTypes.COLLECTIVE_VIRTUAL_CARD_ADDED:
    case ActivityTypes.COLLECTIVE_VIRTUAL_CARD_MISSING_RECEIPTS:
      await notify.collective(activity);
      break;

    case ActivityTypes.ORDER_PENDING_CRYPTO:
    case ActivityTypes.ORDER_PENDING:
    case ActivityTypes.ORDER_PROCESSING:
    case ActivityTypes.ORDER_PAYMENT_FAILED:
      await notify.user(activity, {
        from: emailLib.generateFromEmailHeader(activity.data.collective.name),
      });
      break;

    case ActivityTypes.COLLECTIVE_MEMBER_INVITED:
      await notify.collective(activity, {
        template: 'member.invitation',
        collectiveId: activity.data.memberCollective.id,
      });
      break;

    case ActivityTypes.VIRTUAL_CARD_CHARGE_DECLINED:
      if (activity.UserId) {
        await notify.user(activity);
      } else {
        await notify.collective(activity);
      }
      break;

    case ActivityTypes.SUBSCRIPTION_CANCELED:
      await notify.user(activity);
      break;

    case ActivityTypes.COLLECTIVE_MEMBER_CREATED:
      twitter.tweetActivity(activity);
      await notify.collective(activity, { collectiveId: activity.data.collective.id });
      break;

    case ActivityTypes.COLLECTIVE_CONTACT:
      await notify.collective(activity, { replyTo: activity.data.user.email });
      break;

    // Custom Notification Logic
    case ActivityTypes.USER_CARD_INVITED:
      emailLib.send(activity.type, activity.data.email, activity.data);
      break;

    case ActivityTypes.TICKET_CONFIRMED: {
      const user = await models.User.findByPk(activity.UserId);
      const event = await models.Collective.findByPk(activity.data.EventCollectiveId);
      const parentCollective = await event.getParentCollective();
      const ics = await event.getICS();
      const options = {
        attachments: [{ filename: `${event.slug}.ics`, content: ics }],
        from: emailLib.generateFromEmailHeader(parentCollective.name),
      };

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
      await notify.user(activity, { ...options, userId: user.id });
      break;
    }

    case ActivityTypes.COLLECTIVE_UPDATE_PUBLISHED: {
      twitter.tweetActivity(activity);
      if (activity.data.update?.isChangelog) {
        return;
      }
      const collective = await models.Collective.findByPk(activity.data.collective.id);
      activity.data.fromCollective = (await models.Collective.findByPk(activity.data.fromCollective.id))?.info;
      activity.data.collective = collective.info;
      activity.data.fromEmail = emailLib.generateFromEmailHeader(activity.data.collective.name);
      activity.CollectiveId = collective.id;

      const emailOpts = { from: activity.data.fromEmail };
      const update = await models.Update.findByPk(activity.data.update.id);
      const allUsers = await update.getUsersToNotify();
      activity.data.update.html = replaceVideosByImagePreviews(activity.data.update.html);
      await notify.users(allUsers, activity, emailOpts);
      break;
    }

    case ActivityTypes.COLLECTIVE_CONVERSATION_CREATED:
      activity.data.collective = await models.Collective.findByPk(activity.data.conversation.CollectiveId);
      activity.data.fromCollective = await models.Collective.findByPk(activity.data.conversation.FromCollectiveId);
      activity.data.rootComment = await models.Comment.findByPk(activity.data.conversation.RootCommentId);
      activity.data.collective = activity.data.collective?.info;
      activity.data.fromCollective = activity.data.fromCollective?.info;
      activity.data.rootComment = activity.data.rootComment?.info;
      await notify.collective(activity, { exclude: [activity.UserId] });
      break;

    case ActivityTypes.CONVERSATION_COMMENT_CREATED: {
      await populateCommentActivity(activity);
      const conversation = await models.Conversation.findByPk(activity.data.ConversationId);
      activity.data.conversation = conversation.info;
      activity.data.UserId = get(activity.data.conversation, 'CreatedByUserId');
      activity.data.path = `/${activity.data.collective.slug}/conversations/${activity.data.conversation.slug}-${activity.data.conversation.hashId}`;

      // Skip root comment as the notification is covered by the "New conversation" email
      if (conversation.RootCommentId === activity.data.comment.id) {
        return;
      }

      const usersToNotify: Array<User> = await conversation.getUsersFollowing();
      notify.users(usersToNotify, activity, {
        from: config.email.noReply,
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
      await notify.collective(activity, {
        from: config.email.noReply,
        exclude: [activity.UserId], // Don't notify the person who commented
      });
      break;
    }

    case ActivityTypes.EXPENSE_COMMENT_CREATED: {
      const { collective } = await populateCommentActivity(activity);
      const HostCollectiveId = await collective.getHostCollectiveId();
      if (HostCollectiveId) {
        const hostCollective = await models.Collective.findByPk(HostCollectiveId);
        activity.data.hostCollective = hostCollective.info;
      }
      activity.data.expense = await models.Expense.findByPk(activity.ExpenseId);
      activity.data.expense = activity.data.expense.info;
      activity.data.UserId = activity.data.expense.UserId;
      activity.data.path = `/${activity.data.collective.slug}/expenses/${activity.data.expense.id}`;

      // Notify the admins of the collective
      await notify.collective(activity, {
        from: config.email.noReply,
        exclude: [activity.UserId, activity.data.UserId], // Don't notify the person who commented nor the expense author
      });

      // Notify the admins of the host (if any)
      if (HostCollectiveId) {
        await notify.collective(activity, {
          from: config.email.noReply,
          collectiveId: HostCollectiveId,
          exclude: [activity.UserId, activity.data.UserId], // Don't notify the person who commented nor the expense author
        });
      }

      // Notify the author of the expense
      if (activity.UserId !== activity.data.UserId) {
        await notify.user(activity, {
          userId: activity.data.UserId,
          from: config.email.noReply,
        });
      }
      break;
    }

    case ActivityTypes.COLLECTIVE_EXPENSE_APPROVED:
      activity.data.actions = {
        viewLatestExpenses: `${config.host.website}/${activity.data.collective.slug}/expenses#expense${activity.data.expense.id}`,
      };
      activity.data.expense.payoutMethodLabel = models.PayoutMethod.getLabel(activity.data.payoutMethod);
      await notify.user(activity, { from: config.email.noReply, userId: activity.data.expense.UserId });
      // We only notify the admins of the host if the collective is active (ie. has been approved by the host)
      if (get(activity, 'data.host.id') && get(activity, 'data.collective.isActive')) {
        await notify.collective(activity, {
          template: 'collective.expense.approved.for.host',
          collectiveId: activity.data.host.id,
        });
      }
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_UPDATED:
      if (activity.data.notifyCollective) {
        await notify.collective(activity);
      }
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_REJECTED:
      activity.data.actions = {
        viewLatestExpenses: `${config.host.website}/${activity.data.collective.slug}/expenses#expense${activity.data.expense.id}`,
      };
      await notify.user(activity, {
        from: config.email.noReply,
        userId: activity.data.expense.UserId,
      });
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_PAID:
      activity.data.actions = {
        viewLatestExpenses: `${config.host.website}/${activity.data.collective.slug}/expenses#expense${activity.data.expense.id}`,
      };
      activity.data.expense.payoutMethodLabel = models.PayoutMethod.getLabel(activity.data.payoutMethod);
      await notify.user(activity, {
        from: config.email.noReply,
        userId: activity.data.expense.UserId,
      });
      if (get(activity, 'data.host.id')) {
        await notify.collective(activity, {
          collectiveId: activity.data.host.id,
          template: 'collective.expense.paid.for.host',
        });
      }
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_ERROR:
      activity.data.actions = {
        viewLatestExpenses: `${config.host.website}/${activity.data.collective.slug}/expenses#expense${activity.data.expense.id}`,
      };
      await notify.user(activity, {
        from: config.email.noReply,
        userId: activity.data.expense.UserId,
      });
      if (get(activity, 'data.host.id')) {
        await notify.collective(activity, {
          collectiveId: activity.data.host.id,
          template: 'collective.expense.error.for.host',
        });
      }
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_PROCESSING:
      activity.data.actions = {
        viewLatestExpenses: `${config.host.website}/${activity.data.collective.slug}/expenses#expense${activity.data.expense.id}`,
      };
      await notify.user(activity, { from: config.email.noReply, userId: activity.data.expense.UserId });
      break;

    case ActivityTypes.COLLECTIVE_APPROVED:
      // Funds MVP
      if (get(activity, 'data.collective.type') === 'FUND' || get(activity, 'data.collective.settings.fund') === true) {
        if (get(activity, 'data.host.slug') === 'foundation') {
          await notify.collective(activity, {
            collectiveId: activity.CollectiveId,
            template: 'fund.approved.foundation',
          });
        }
        break;
      }
      await notify.collective(activity, {
        collectiveId: activity.CollectiveId,
        replyTo: activity.data.host.data?.replyToEmail || undefined,
      });
      break;

    case ActivityTypes.COLLECTIVE_REJECTED:
      // Funds MVP
      if (get(activity, 'data.collective.type') === 'FUND' || get(activity, 'data.collective.settings.fund') === true) {
        break;
      }
      await notify.collective(activity, {
        collectiveId: activity.CollectiveId,
        template: 'collective.rejected',
        replyTo: activity.data.host.data?.replyToEmail || undefined,
      });
      break;

    case ActivityTypes.COLLECTIVE_APPLY:
      await notify.collective(activity, {
        collectiveId: activity.data.host.id,
        template: 'collective.apply.for.host',
        replyTo: activity.data.user.email,
      });

      // Funds MVP, we assume the info is already sent in COLLECTIVE_CREATED
      if (get(activity, 'data.collective.type') === 'FUND' || get(activity, 'data.collective.settings.fund') === true) {
        break;
      }

      await notify.collective(activity, {
        collectiveId: activity.data.collective.id,
        from: `no-reply@opencollective.com`,
      });
      break;

    case ActivityTypes.COLLECTIVE_CREATED:
      // Funds MVP
      if (get(activity, 'data.collective.type') === 'FUND' || get(activity, 'data.collective.settings.fund') === true) {
        if (get(activity, 'data.host.slug') === 'foundation') {
          await notify.collective(activity, {
            collectiveId: activity.CollectiveId,
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
      await notify.collective(activity, { collectiveId: activity.data.collective.id });
      break;

    case ActivityTypes.COLLECTIVE_CREATED_GITHUB:
      await notify.collective(activity, {
        collectiveId: activity.data.collective.id,
        template: 'collective.created.opensource',
      });
      notify.user(activity, { template: 'github.signup' });
      break;

    case ActivityTypes.BACKYOURSTACK_DISPATCH_CONFIRMED:
      for (const order of activity.data.orders) {
        const collective = await models.Collective.findByPk(order.CollectiveId);
        order.collective = collective.info;
      }
      await notify.collective(activity, {
        collectiveId: activity.data.collective.id,
        template: 'backyourstack.dispatch.confirmed',
      });
      break;

    case ActivityTypes.ACTIVATED_COLLECTIVE_AS_HOST:
      await notify.collective(activity, {
        collectiveId: activity.data.collective.id,
        template: 'activated.collective.as.host',
      });
      break;

    case ActivityTypes.ACTIVATED_COLLECTIVE_AS_INDEPENDENT:
      await notify.collective(activity, {
        collectiveId: activity.data.collective.id,
        template: 'activated.collective.as.independent',
      });
      break;

    case ActivityTypes.DEACTIVATED_COLLECTIVE_AS_HOST:
      await notify.collective(activity, {
        collectiveId: activity.data.collective.id,
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
        await notify.collective(activity, {
          collectiveId: activity.data.payee.id,
        });
      } else if (activity.data.payee.slug) {
        const collective = await models.Collective.findBySlug(activity.data.payee.slug);
        await notify.collective(activity, { collective });
      }
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_RECURRING_DRAFTED:
      await notify.collective(activity, {
        collectiveId: activity.data.payee.id,
      });
      break;

    case ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE:
      await notify.collective(activity, {
        collectiveId: activity.data.fromCollective.id,
      });
      break;

    case ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED:
    case ActivityTypes.COLLECTIVE_VIRTUAL_CARD_DELETED: {
      activity.data.hostCollective = activity.data.host;
      await notify.collective(activity, {
        collectiveId: activity.data.collective.id,
      });
      await notify.collective(activity, {
        collectiveId: activity.data.host.id,
      });
      break;
    }
    case ActivityTypes.VIRTUAL_CARD_REQUESTED:
      await notify.collective(activity, {
        collectiveId: activity.data.host.id,
        template: 'virtualcard.requested',
        replyTo: activity.data.user.email,
      });
      break;

    case ActivityTypes.VIRTUAL_CARD_PURCHASE:
      await notify.collective(activity);
      break;

    case ActivityTypes.CONTRIBUTION_REJECTED:
      await notify.collective(activity, {
        collectiveId: activity.data.fromCollective.id,
      });
      break;

    case ActivityTypes.ORDER_PENDING_RECEIVED:
      if (activity.data?.fromAccountInfo?.email) {
        await emailLib.send(activity.type, activity.data.fromAccountInfo.email, activity.data);
      }
      await notify.collective(activity);
      break;

    case ActivityTypes.ORDER_PENDING_CONTRIBUTION_NEW:
    case ActivityTypes.ORDER_PENDING_CONTRIBUTION_REMINDER:
      await notify.collective(activity, {
        collectiveId: activity.data.host.id,
        replyTo: activity.data.replyTo,
      });
      break;

    case ActivityTypes.PAYMENT_FAILED:
    case ActivityTypes.PAYMENT_CREDITCARD_CONFIRMATION:
    case ActivityTypes.ORDER_CANCELED_ARCHIVED_COLLECTIVE: {
      const { fromCollective, collective } = activity.data;
      await notify.collective(activity, {
        collectiveId: fromCollective.id,
        from: emailLib.generateFromEmailHeader(collective.name),
      });
      break;
    }

    default:
      break;
  }
};

/** Backward compatible shim */
export const notifyAdminsOfCollective = async (
  collectiveId: number,
  activity: Partial<Activity>,
  options: NotifySubscribersOptions = {},
) => notify.collective(activity, { ...options, collectiveId });

/** Backward compatible shim */
export const notifyAdminsAndAccountantsOfCollective = async (
  collectiveId: number,
  activity: Partial<Activity>,
  options: NotifySubscribersOptions = {},
) => notify.collective(activity, { ...options, collectiveId, role: [roles.ACCOUNTANT, roles.ADMIN] });
