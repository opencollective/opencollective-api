import config from 'config';
import { lowerCase } from 'lodash';

import activities from '../constants/activities';
import { TransactionTypes } from '../constants/transactions';

import { formatCurrency } from './currency';
import { capitalize } from './utils';

export default {
  /**
   * Formats an activity *FOR EXTERNAL USE* based on its type
   * This function strips out email addresses and shows only a subset of activities
   * because many of them aren't relevant externally (like USER_CREATED)
   *
   * @returns {Object} - { message: string }
   */
  formatMessageForPublicChannel: (activity, format) => {
    const result = doFormatMessage(activity, format);
    return typeof result === 'string' ? { message: result } : result;
  },
};

const doFormatMessage = (activity, format) => {
  let userString = '',
    hostString = '';
  let collectiveName = '';
  let fromCollective = '';
  let publicUrl = '';
  let amount = null;
  let interval = '';
  let recurringAmount = null;
  let currency = '';
  let description = '';

  // get user data
  if (activity.data.user) {
    userString = getUserString(format, activity.data.fromCollective);
  }

  if (activity.data.fromCollective) {
    fromCollective = getUserString(format, activity.data.fromCollective);
    if (fromCollective) {
      fromCollective = linkify(format, `${config.host.website}/${activity.data.fromCollective.slug}`, fromCollective);
    }
  }

  // get collective data
  if (activity.data.collective) {
    collectiveName = activity.data.collective.name;
    ({ publicUrl } = activity.data.collective);
  }

  // get host data
  if (activity.data.host) {
    hostString = `on ${getUserString(format, activity.data.host)}`;
  }

  // get donation data
  if (activity.data.order) {
    amount = activity.data.order.totalAmount / 100;
    ({ currency } = activity.data.order);
  }

  // get subscription data
  if (activity.data.subscription) {
    ({ interval } = activity.data.subscription);
    amount = amount || activity.data.subscription.amount / 100;
    recurringAmount = amount + (interval ? `/${interval}` : '');
  }

  // get transaction data
  if (activity.data.transaction) {
    amount = Math.abs(activity.data.transaction.amount / 100);
    recurringAmount = amount + (interval ? `/${interval}` : '');
    ({ currency } = activity.data.transaction);
    ({ description } = activity.data.transaction);
  }

  // get expense data
  if (activity.data.expense) {
    amount = amount || activity.data.expense.amount / 100;
    currency = currency || activity.data.expense.currency;
    description = linkify(
      format,
      `${config.host.website}/${activity.data.collective.slug}/expenses/${activity.data.expense.id}`,
      description || activity.data.expense.description,
    );
  }

  // get update data
  let update;
  if (activity.data.update) {
    update = linkify(format, activity.data.url, 'update');
  }

  // get member data
  let member;
  if (activity.data.member) {
    const memberCollective = activity.data.member.memberCollective;
    if (memberCollective.isGuest || memberCollective.isIncognito) {
      member = memberCollective.name || 'A guest';
    } else {
      member = linkify(format, `${config.host.website}/${memberCollective.slug}`, memberCollective.name);
    }
  }

  const collective = linkify(format, publicUrl, collectiveName);

  switch (activity.type) {
    // Currently used for both new donation and expense
    // @deprecated This activity type is deprecated in favor of ORDER_PROCESSED
    case activities.COLLECTIVE_TRANSACTION_CREATED:
      if (activity.data.transaction.type === TransactionTypes.CREDIT) {
        return `New financial contribution: ${userString} gave ${currency} ${amount} to ${collective}`;
      } else if (activity.data.transaction.ExpenseId) {
        return `New transaction for paid expense "${description}" (${currency} ${amount}) on ${collective}`;
      } else if (activity.data.transaction.isRefund) {
        return `A transaction (${currency} ${amount}) on ${collective} was refunded: ${description}`;
      } else {
        return `New debit transaction on ${collective} for ${currency} ${amount}`;
      }

    // Account activities
    case activities.COLLECTIVE_CREATED:
      return `New collective created by ${userString}: ${collective} ${hostString}`.trim();

    case activities.COLLECTIVE_EDITED:
      return `Account edited: ${collective} has been updated`;

    case activities.COLLECTIVE_DELETED:
      return `Account deleted: ${collectiveName} has been deleted`;

    // Expense Activities
    case activities.COLLECTIVE_EXPENSE_DELETED:
      return `Expense deleted: ${currency} ${amount} for ${description} in ${collective}`;

    case activities.COLLECTIVE_EXPENSE_UPDATED:
      return `Expense updated: ${currency} ${amount} for ${description} in ${collective}`;

    case activities.COLLECTIVE_EXPENSE_UNAPPROVED:
      return `Expense unapproved: ${currency} ${amount} for ${description} in ${collective}`;

    case activities.COLLECTIVE_EXPENSE_MOVED:
      return `Expense moved: ${currency} ${amount} for ${description} in ${collective}`;

    case activities.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID:
      return `Expense marked as unpaid: ${currency} ${amount} for ${description} in ${collective}`;

    case activities.COLLECTIVE_EXPENSE_MARKED_AS_SPAM:
      return `Expense marked as spam: ${currency} ${amount} for ${description} in ${collective}`;

    case activities.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE:
      return `Expense marked as incomplete: ${currency} ${amount} for ${description} in ${collective}`;

    case activities.COLLECTIVE_EXPENSE_ERROR:
      return `Error with expense: ${currency} ${amount} for ${description} in ${collective}`;

    case activities.COLLECTIVE_EXPENSE_CREATED:
      return `New Expense: ${userString} submitted an expense to ${collective}: ${currency} ${amount} for ${description}`;

    case activities.COLLECTIVE_EXPENSE_REJECTED:
      return `Expense rejected: ${currency} ${amount} for ${description} in ${collective}`;

    case activities.COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED:
      return `Expense needs re-approval: ${currency} ${amount} for ${description} in ${collective}`;

    case activities.COLLECTIVE_EXPENSE_APPROVED:
      return `Expense approved: ${currency} ${amount} for ${description} in ${collective}`;

    case activities.COLLECTIVE_EXPENSE_PAID:
      return `Expense paid on ${collective}: ${currency} ${amount} for '${description}'`;

    // Contributions Related Activities

    case activities.SUBSCRIPTION_CONFIRMED:
      return `New subscription confirmed: ${currency} ${recurringAmount} from ${userString} to ${collective}`;

    case activities.ORDERS_SUSPICIOUS:
      return `Suspicious Contribution: ${fromCollective}'s ${currency} ${amount} contribution to ${collective}. Score: ${activity.data.recaptchaResponse.score}`;

    case activities.ORDER_PROCESSED:
      return `Contribution processed: ${fromCollective} gave ${currency} ${amount} to ${collective}`;

    case activities.TICKET_CONFIRMED:
      return `Ticket confirmed by ${fromCollective} for event at ${collective}`;

    case activities.ORDER_UPDATED:
      return `Contribution from ${fromCollective} updated for ${collective}`;

    // Updates
    case activities.COLLECTIVE_UPDATE_CREATED:
      return `New ${update} drafted on ${collective}`;

    case activities.COLLECTIVE_UPDATE_PUBLISHED:
      return `New ${update} published on ${collective}`;

    // Hosted Collective Related Activities
    case activities.COLLECTIVE_APPLY:
      return handleCollectiveApply(activity, format);

    case activities.COLLECTIVE_APPROVED:
      return `Collective approved: ${collective} has been approved by ${linkify(format, `${config.host.website}/${activity.data.host.slug}`, activity.data.host.name)}`;

    case activities.COLLECTIVE_REJECTED:
      return `Collective rejected: ${collective} has been rejected by ${linkify(format, `${config.host.website}/${activity.data.host.slug}`, activity.data.host.name)}`;

    case activities.COLLECTIVE_UNHOSTED:
      return `Collective unhosted: ${collective} is no longer hosted by ${getUserString(format, activity.data.host)}`;

    case activities.COLLECTIVE_FROZEN:
      return `Collective frozen: ${collective} has been frozen`;

    case activities.COLLECTIVE_UNFROZEN:
      return `Collective unfrozen: ${collective} has been unfrozen`;

    // Comment Related Activities
    case activities.COLLECTIVE_CONVERSATION_CREATED:
      return `New conversation started on ${collective} by ${userString}`;

    case activities.UPDATE_COMMENT_CREATED:
      return `New comment on update by ${userString} on ${collective}`;

    case activities.EXPENSE_COMMENT_CREATED:
      return `New comment on expense by ${userString} on ${collective}`;

    case activities.CONVERSATION_COMMENT_CREATED:
      return `New comment in conversation by ${userString} on ${collective}`;

    case activities.ORDER_COMMENT_CREATED:
      return `New comment on contribution by ${userString} on ${collective}`;

    // Member Activities
    case activities.COLLECTIVE_MEMBER_CREATED:
      if (amount) {
        return `${member} just joined ${collective} and contributed with ${formatCurrency(currency, amount)}`;
      } else {
        return `New member ${member} joined ${collective}`;
      }

    case activities.COLLECTIVE_MEMBER_INVITED:
      return `New member invited to ${collective}`;

    case activities.COLLECTIVE_CORE_MEMBER_ADDED:
      return `New core member added to ${collective}`;

    case activities.COLLECTIVE_CORE_MEMBER_INVITED:
      return `New core member invited to ${collective}`;

    case activities.COLLECTIVE_CORE_MEMBER_INVITATION_DECLINED:
      return `Core member invitation declined for ${collective}`;

    case activities.COLLECTIVE_CORE_MEMBER_REMOVED:
      return `Core member removed from ${collective}`;

    case activities.COLLECTIVE_CORE_MEMBER_EDITED:
      return `Core member role updated in ${collective}`;

    // Contact Activities
    case activities.HOST_APPLICATION_COMMENT_CREATED:
      return `New comment on host application for ${collective}`;

    // Virtual cards
    case activities.VIRTUAL_CARD_PURCHASE:
      return `New virtual card purchase: A virtual card purchase of amount ${currency} ${amount} for ${description} was submitted!`;

    default:
      return '';
  }
};

const handleCollectiveApply = (activity, format) => {
  const { collective, host } = activity.data;
  const collectiveStr = linkify(format, `${config.host.website}/${collective.slug}`, collective.name);
  const hostStr = linkify(format, `${config.host.website}/${host.slug}`, host.name);
  const message = `${collectiveStr} requested to be hosted by ${hostStr}`;
  if (format !== 'slack') {
    return message;
  }

  let options;
  if (activity.data.application) {
    options = { attachments: [] };
    if (activity.data.application.message) {
      options.attachments.push({ text: activity.data.application.message });
    }
    if (activity.data.application.customData) {
      options.attachments.push({
        title: 'Custom data',
        fields: Object.entries(activity.data.application.customData).map(([key, value]) => ({
          title: capitalize(lowerCase(key)),
          value,
        })),
      });
    }
  }

  return { message, options };
};

/**
 * Generates a url for Slack
 */
const linkify = (format: 'slack' | 'markdown', link: string, text: string): string => {
  switch (format) {
    case 'slack':
      if (link && !text) {
        text = link;
      } else if (!link && text) {
        return text;
      } else if (!link && !text) {
        return '';
      }
      return `<${link}|${text}>`;

    case 'markdown':
    default:
      return `[${text}](${link})`;
  }
};

/**
 * Generates a userString given a user's info
 */
const getUserString = (
  format: 'slack' | 'markdown',
  userCollective: { name?: string; twitterHandle?: string; website?: string },
): string => {
  userCollective = userCollective || {};
  const userString = userCollective.name || userCollective.twitterHandle || 'someone';
  const link = userCollective.website;

  let returnVal;
  if (link) {
    returnVal = linkify(format, link, userString);
  } else {
    returnVal = userString;
  }

  return returnVal;
};

const LEGACY_TRANSACTION_ACTIVITY_COLLECTIVE_IDS = config.activities?.legacyTransactionsCollectiveIds
  ? config.activities.legacyTransactionsCollectiveIds.split(',').map(Number)
  : [];

/**
 * Returns true if a `collective.transaction.created` activity should be generated for the given collective.
 * Implemented as a separate function to allow for easy testing.
 */
export const shouldGenerateTransactionActivities = (collectiveId: number): boolean => {
  return LEGACY_TRANSACTION_ACTIVITY_COLLECTIVE_IDS.includes(collectiveId);
};
