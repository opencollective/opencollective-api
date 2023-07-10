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
  let publicUrl = '';
  let amount = null;
  let interval = '';
  let recurringAmount = null;
  let currency = '';
  let description = '';
  let userTwitter = '';
  let collectiveTwitter = '';
  let tweet = '';

  // get user data
  if (activity.data.user) {
    userString = getUserString(format, activity.data.fromCollective);
    if (activity.data.fromCollective) {
      userTwitter = activity.data.fromCollective.twitterHandle;
    }
  }

  // get collective data
  if (activity.data.collective) {
    collectiveName = activity.data.collective.name;
    ({ publicUrl } = activity.data.collective);
    collectiveTwitter = activity.data.collective.twitterHandle;
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

  let tweetLink,
    tweetThis = '';

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

  let collective;
  if (linkify) {
    collective = linkify(format, publicUrl, collectiveName);
  } else {
    collective = collectiveName;
  }

  switch (activity.type) {
    // Currently used for both new donation and expense
    case activities.COLLECTIVE_TRANSACTION_CREATED:
      if (activity.data.transaction.type === TransactionTypes.CREDIT) {
        if (userTwitter) {
          tweet = encodeURIComponent(
            `@${userTwitter} thanks for your ${formatCurrency(currency, recurringAmount)} contribution to ${
              collectiveTwitter ? `@${collectiveTwitter}` : collectiveName
            } 👍 ${publicUrl}`,
          );
          tweetLink = linkify(format, `https://twitter.com/intent/tweet?text=${tweet}`, 'Thank that person on Twitter');
          tweetThis = ` [${tweetLink}]`;
        }
        return `New financial contribution: ${userString} gave ${currency} ${amount} to ${collective}!${tweetThis}`;
      } else if (activity.data.transaction.ExpenseId) {
        return `New transaction for paid expense "${description}" (${currency} ${amount}) on ${collective}`;
      } else if (activity.data.transaction.isRefund) {
        return `A transaction (${currency} ${amount}) on ${collective} was refunded: ${description}`;
      } else {
        return `New debit transaction on ${collective} for ${currency} ${amount}`;
      }

    case activities.COLLECTIVE_EXPENSE_CREATED:
      return `New Expense: ${userString} submitted an expense to ${collective}: ${currency} ${amount} for ${description}!`;

    case activities.COLLECTIVE_EXPENSE_REJECTED:
      return `Expense rejected: ${currency} ${amount} for ${description} in ${collective}!`;

    case activities.COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED:
      return `Expense needs re-approval: ${currency} ${amount} for ${description} in ${collective}!`;

    case activities.COLLECTIVE_EXPENSE_APPROVED:
      return `Expense approved: ${currency} ${amount} for ${description} in ${collective}!`;

    case activities.COLLECTIVE_EXPENSE_PAID:
      return `Expense paid on ${collective}: ${currency} ${amount} for '${description}'`;

    case activities.SUBSCRIPTION_CONFIRMED:
      if (userTwitter) {
        tweet = encodeURIComponent(
          `@${userTwitter} thanks for your ${formatCurrency(currency, recurringAmount)} contribution to ${
            collectiveTwitter ? `@${collectiveTwitter}` : collectiveName
          } 👍 ${publicUrl}`,
        );
        tweetLink = linkify(format, `https://twitter.com/intent/tweet?text=${tweet}`, 'Thank that person on Twitter');
        tweetThis = ` [${tweetLink}]`;
      }
      return `New subscription confirmed: ${currency} ${recurringAmount} from ${userString} to ${collective}!${tweetThis}`;

    case activities.COLLECTIVE_CREATED:
      return `New collective created by ${userString}: ${collective} ${hostString}`.trim();

    case activities.ORDERS_SUSPICIOUS:
      return `Suspicious Order: ${userString} gave ${currency} ${amount} to ${collective}. Score: ${activity.data.recaptchaResponse.score}`;

    case activities.COLLECTIVE_APPLY:
      return handleCollectiveApply(activity, format);

    case activities.COLLECTIVE_UPDATE_CREATED:
      return `New update drafted on ${collective}`;

    case activities.COLLECTIVE_UPDATE_PUBLISHED:
      return `New ${update} published on ${collective}`;

    case activities.COLLECTIVE_MEMBER_CREATED:
      if (amount) {
        return `${member} just joined ${collective} and contributed with ${formatCurrency(currency, amount)}`;
      } else {
        return `New member ${member} joined ${collective}`;
      }

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
const linkify = (format, link, text) => {
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
const getUserString = (format, userCollective, email) => {
  userCollective = userCollective || {};
  const userString = userCollective.name || userCollective.twitterHandle || 'someone';
  const link = userCollective.twitterHandle
    ? `https://twitter.com/${userCollective.twitterHandle}`
    : userCollective.website;

  let returnVal;
  if (link) {
    returnVal = linkify(format, link, userString);
  } else {
    returnVal = userString;
  }

  if (email) {
    returnVal += ` (${email})`;
  }
  return returnVal;
};
