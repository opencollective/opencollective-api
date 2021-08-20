import * as LibTaxes from '@opencollective/taxes';
import config from 'config';
import { get, isEmpty, pick, some } from 'lodash';

import { types as CollectiveTypes } from '../constants/collectives';
import { MODERATION_CATEGORIES } from '../constants/moderation-categories';
import { VAT_OPTIONS } from '../constants/vat';
import models, { Op, sequelize } from '../models';

import { DEFAULT_GUEST_NAME } from './guest-accounts';
import logger from './logger';
import { md5 } from './utils';

type AvatarUrlOpts = {
  height?: boolean;
  format?: string;
};

/**
 * Returns an URL for the given collective params
 * @param {String} collectiveSlug
 * @param {String} collectiveType
 * @param {String|null} image
 * @param {Object} args
 *    - height
 *    - format
 */
export const getCollectiveAvatarUrl = (
  collectiveSlug: string,
  collectiveType: CollectiveTypes,
  image: string,
  args: AvatarUrlOpts,
): string => {
  const sections = [config.host.images, collectiveSlug];

  if (image) {
    sections.push(md5(image).substring(0, 7));
  }

  sections.push(collectiveType === CollectiveTypes.USER ? 'avatar' : 'logo');

  if (args.height) {
    sections.push(args.height);
  }

  return `${sections.join('/')}.${args.format || 'png'}`;
};

export const COLLECTIVE_SETTINGS_KEYS_LIST = [
  'apply',
  'disablePublicExpenseSubmission',
  'disablePaypalPayouts',
  'bitcoin',
  'categories',
  'collectivePage',
  'disableCustomContributions',
  'dismissedHelpMessages',
  'disableCryptoContributions',
  'editor',
  'enableWebhooks',
  'features',
  'feesOnTop',
  'fund',
  'githubOrg',
  'githubOrgs',
  'githubRepo',
  'githubUsers',
  'goals',
  'goalsInterpolation',
  'hideCreditCardPostalCode',
  'hostCollective',
  'hostFeePercent',
  'HostId',
  'invoice',
  'invoiceTitle',
  'isHostCollective',
  'lang',
  'matchingFund',
  'moderation',
  'paymentMethods',
  'payoutsTwoFactorAuth',
  'recommendedCollectives',
  'style',
  'superCollectiveTag',
  'taxDeductibleDonations',
  'tos',
  'twitter',
  'VAT',
  'GST',
  'giftCardsMaxDailyCount',
  'W9',
  'virtualcards',
  'transferwise',
];

/**
 * Whitelist the collective settings that can be updated.
 * TODO: Filter all settings fields
 */
export function filterCollectiveSettings(settings: Record<string, unknown> | null): Record<string, unknown> {
  if (!settings) {
    return null;
  }

  const preparedSettings = { ...settings };

  if (preparedSettings.VAT) {
    preparedSettings.VAT = pick(preparedSettings.VAT, ['number', 'type']);
  }

  if (preparedSettings.GST) {
    preparedSettings.GST = pick(preparedSettings.GST, ['number']);
  }

  // Generate warnings for invalid settings
  Object.keys(settings).forEach(key => {
    if (!COLLECTIVE_SETTINGS_KEYS_LIST.includes(key)) {
      logger.warn(`Invalid collective setting key detected: ${key}`);
    }
  });

  return preparedSettings;
}

/**
 * Returns false if settings are valid or an error as string otherwise
 * @param {object|null} settings
 */
export function validateSettings(settings: any): string | boolean {
  if (!settings) {
    return false;
  }

  // Validate VAT
  if (settings.VAT) {
    if (typeof settings.VAT !== 'object') {
      return 'Invalid type for VAT settings';
    } else if (settings.VAT.number && !LibTaxes.checkVATNumberFormat(settings.VAT.number).isValid) {
      return 'Invalid VAT number';
    } else if (settings.VAT.type && settings.VAT.type !== VAT_OPTIONS.HOST && settings.VAT.type !== VAT_OPTIONS.OWN) {
      return 'Invalid VAT configuration';
    }
  }

  if (settings.moderation?.rejectedCategories) {
    const categories = get(settings, 'moderation.rejectedCategories');
    for (const category of categories) {
      if (!Object.keys(MODERATION_CATEGORIES).includes(category)) {
        return 'Invalid filtering category';
      }
    }
  }

  if (settings) {
    return false;
  }
}

export const collectiveSlugReservedList = [
  'about',
  'accept-financial-contributions',
  'admin',
  'applications',
  'apply',
  'become-a-fiscal-host',
  'become-a-host',
  'become-a-sponsor',
  'chapters',
  'collective',
  'collectives',
  'confirm',
  'contact',
  'contribute',
  'conversations',
  'create',
  'create-account',
  'delete',
  'deleteCollective',
  'discover',
  'donate',
  'edit',
  'email',
  'embed',
  'event',
  'events',
  'expense',
  'expenses',
  'faq',
  'fund',
  'gift-card',
  'gift-cards',
  'gift-cards-next',
  'gift-of-giving',
  'help',
  'hiring',
  'home',
  'host',
  'hosts',
  'how-it-works',
  'index',
  'join',
  'join-free',
  'learn-more',
  'member',
  'member-invitations',
  'members',
  'onboarding',
  'order',
  'orders',
  'organizations',
  'pledge',
  'pledges',
  'pricing',
  'privacypolicy',
  'project',
  'projects',
  'recurring-contributions',
  'redeem',
  'redeemed',
  'redirect',
  'register',
  'search',
  'signin',
  'signup',
  'subscriptions',
  'superpowers',
  'support',
  'tiers',
  'tos',
  'transactions',
  'updates',
  'website',
  'widgets',
];

/**
 * Check if given `slug` could conflict with existing routes or
 * if it's a reserved keyword.
 *
 * The list is mostly based on frontend `src/server/pages.js` file and
 * `src/pages/static` content.
 *
 * @param {String} slug
 */
export function isCollectiveSlugReserved(slug: string): boolean {
  return collectiveSlugReservedList.includes(slug);
}

const mergeCollectiveFields = async (from, into, transaction) => {
  const fieldsToUpdate = {};
  const isTmpName = name => !name || name === DEFAULT_GUEST_NAME || name === 'Incognito';
  if (isTmpName(into.name) && !isTmpName(from.name)) {
    fieldsToUpdate['name'] = from.name;
  }

  if (from.countryISO && !into.countryISO) {
    fieldsToUpdate['countryISO'] = from.countryISO;
  }

  if (from.address && !into.address) {
    fieldsToUpdate['address'] = from.address;
  }

  return isEmpty(fieldsToUpdate) ? into : into.update(fieldsToUpdate, { transaction });
};

/**
 * Get a summary of all items handled by the `mergeCollectives` function
 */
export const getMovableItemsCount = async fromCollective => {
  return {
    activities: await models.Update.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    applications: await models.Application.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    members: await models.Member.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ MemberCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    memberInvitations: await models.MemberInvitation.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ MemberCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    orders: await models.Order.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ FromCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    paymentMethods: await models.PaymentMethod.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    tiers: await models.Tier.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    transactions: await models.Transaction.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ FromCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
  };
};

/**
 * Get a summary of all items **not** handled by the `mergeCollectives` function
 */
export const getUnmovableItemsCounts = async fromCollective => {
  return {
    comments: await models.Comment.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ FromCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    emojiReactions: await models.EmojiReaction.aggregate('id', 'COUNT', {
      where: { FromCollectiveId: fromCollective.id },
    }),
    connectedAccounts: await models.ConnectedAccount.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    conversations: await models.Conversation.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ FromCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    expenses: await models.Expense.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ FromCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    legalDocuments: await models.LegalDocument.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    notifications: await models.Notification.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    payoutMethods: await models.PayoutMethod.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    requiredLegalDocuments: await models.RequiredLegalDocument.aggregate('id', 'COUNT', {
      where: { HostCollectiveId: fromCollective.id },
    }),
    tiers: await models.Tier.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    updates: await models.Update.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
  };
};

const checkMergeCollective = (from: typeof models.Collective, into: typeof models.Collective): void => {
  if (!from || !into) {
    throw new Error('Cannot merge profiles, one of them does not exist');
  } else if (from.type !== into.type) {
    throw new Error('Cannot merge accounts with different types');
  } else if (from.id === into.id) {
    throw new Error('Cannot merge an account into itself');
  } else if (from.id === into.ParentCollectiveId) {
    throw new Error('You can not merge an account with its parent');
  } else if (from.id === into.HostCollectiveId) {
    throw new Error('You can not merge an account with its host');
  }
};

/**
 * Simulate the `mergeCollectives` function. Returns a summary of the changes as a string
 */
export const simulateMergeCollectives = async (
  from: typeof models.Collective,
  into: typeof models.Collective,
): Promise<string> => {
  // Detect errors that would completely block the process (throws)
  checkMergeCollective(from, into);

  // Generate a summary of the changes
  const movedItemsCounts = await getMovableItemsCount(from);
  const notMovedItemsCounts = await getUnmovableItemsCounts(from);
  let summary = 'The profiles information will be merged.\n\n';

  const addLineToSummary = str => {
    summary += `${str}\n`;
  };

  const addCountsToSummary = counts => {
    Object.entries(counts).forEach(([key, count]) => {
      if (count > 0) {
        addLineToSummary(`  - ${key}: ${count}`);
      }
    });
  };

  if (some(movedItemsCounts, count => count > 0)) {
    addLineToSummary(`The following items will be moved to @${into.slug}:`);
    addCountsToSummary(movedItemsCounts);
    addLineToSummary('');
  }

  if (some(notMovedItemsCounts, count => count > 0)) {
    addLineToSummary('The following items will **not** be moved (you need to do that manually):');
    addCountsToSummary(notMovedItemsCounts);
  }

  return summary;
};

/**
 * An helper to merge a collective with another one, with some limitations.
 */
export const mergeCollectives = async (
  from: typeof models.Collective,
  into: typeof models.Collective,
): Promise<void> => {
  // Make sure all conditions are met before we start
  checkMergeCollective(from, into);

  // TODO: Store the migration data somewhere to make rollbacks easier

  // When moving users, we'll also update the user entries
  let fromUser, toUser;
  if (from.type === CollectiveTypes.USER) {
    fromUser = await models.User.findOne({ where: { CollectiveId: from.id } });
    toUser = await models.User.findOne({ where: { CollectiveId: into.id } });
    if (!fromUser || !toUser) {
      throw new Error('Cannot find one of the user entries to merge');
    }
  }

  // Trigger the merge in a transaction
  return sequelize.transaction(async transaction => {
    // Update collective
    await mergeCollectiveFields(from, into, transaction);

    // Update applications
    await models.Application.update({ CollectiveId: into.id }, { where: { CollectiveId: from.id } }, { transaction });

    // Update tiers
    await models.Tier.update({ CollectiveId: into.id }, { where: { CollectiveId: from.id } }, { transaction });

    // Update orders (FROM)
    await models.Order.update({ FromCollectiveId: into.id }, { where: { FromCollectiveId: from.id } }, { transaction });

    // Update orders (TO)
    await models.Order.update({ CollectiveId: into.id }, { where: { CollectiveId: from.id } }, { transaction });

    // Update transactions
    // ... CREDIT
    await models.Transaction.update(
      { FromCollectiveId: into.id },
      { where: { FromCollectiveId: from.id } },
      { transaction },
    );

    // ... DEBIT
    await models.Transaction.update({ CollectiveId: into.id }, { where: { CollectiveId: from.id } }, { transaction });

    // Update payment methods
    await models.PaymentMethod.update({ CollectiveId: into.id }, { where: { CollectiveId: from.id } }, { transaction });

    // Update members
    await models.Member.update(
      { MemberCollectiveId: into.id },
      { where: { MemberCollectiveId: from.id } },
      { transaction },
    );

    // Update memberships
    await models.Member.update({ CollectiveId: into.id }, { where: { CollectiveId: from.id } }, { transaction });

    // Update member invitations
    await models.MemberInvitation.update(
      { MemberCollectiveId: into.id },
      { where: { MemberCollectiveId: from.id } },
      { transaction },
    );

    // Update memberships invitations
    await models.MemberInvitation.update(
      { CollectiveId: into.id },
      { where: { CollectiveId: from.id } },
      { transaction },
    );

    // Update activities
    await models.Activity.update({ CollectiveId: into.id }, { where: { CollectiveId: from.id } }, { transaction });

    // Mark fromUser as deleted
    await fromUser.destroy({ transaction });

    // Mark from profile as deleted
    await models.Collective.update(
      {
        deletedAt: Date.now(),
        slug: `${from.slug}-merged`,
        data: { ...from.data, mergedIntoCollectiveId: into.id },
      },
      {
        where: { id: from.id },
      },
    );
  });
};

/**
 * Returns true if the event is passed
 */
export const isPastEvent = (event: typeof models.Collective): boolean => {
  if (!event.endsAt) {
    return false;
  } else {
    const oneDay = 24 * 60 * 60 * 1000;
    const isOverSince = new Date().getTime() - new Date(event.endsAt).getTime();
    return isOverSince > oneDay;
  }
};
