import * as LibTaxes from '@opencollective/taxes';
import config from 'config';
import { get, pick } from 'lodash';

import { types as CollectiveTypes } from '../constants/collectives';
import { MODERATION_CATEGORIES } from '../constants/moderation-categories';
import { VAT_OPTIONS } from '../constants/vat';
import models, { sequelize } from '../models';

import logger from './logger';
import { md5 } from './utils';

/**
 * Returns an URL for the given collective params
 * @param {String} collectiveSlug
 * @param {String} collectiveType
 * @param {String|null} image
 * @param {Object} args
 *    - height
 *    - format
 */
export const getCollectiveAvatarUrl = (collectiveSlug, collectiveType, image, args) => {
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
  'bitcoin',
  'categories',
  'collectivePage',
  'disableCustomContributions',
  'dismissedHelpMessages',
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
  'virtualCardsMaxDailyCount',
  'W9',
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

export const collectiveSlugReservedlist = [
  'about',
  'accept-financial-contributions',
  'admin',
  'applications',
  'become-a-sponsor',
  'chapters',
  'collective',
  'collectives',
  'confirm',
  'contact',
  'contribute',
  'create',
  'create-account',
  'delete',
  'deleteCollective',
  'discover',
  'donate',
  'edit',
  'event',
  'events',
  'expense',
  'expenses',
  'faq',
  'gift-card',
  'gift-cards',
  'gift-cards-next',
  'gift-of-giving',
  'help',
  'home',
  'host',
  'hosts',
  'how-it-works',
  'join',
  'join-free',
  'learn-more',
  'member-invitations',
  'member',
  'members',
  'onboarding',
  'order',
  'orders',
  'pledge',
  'pledges',
  'pricing',
  'privacypolicy',
  'redeem',
  'redeemed',
  'redirect',
  'register',
  'search',
  'signin',
  'signup',
  'subscriptions',
  'tos',
  'transactions',
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
  return collectiveSlugReservedlist.includes(slug);
}

/**
 * An helper to merge a collective with another one, with some limitations.
 */
export const mergeCollectives = async (
  from: typeof models.Collective,
  into: typeof models.Collective,
): Promise<void> => {
  if (!from || !into) {
    throw new Error('Cannot merge profiles, one of them does not exist');
  } else if (from.type !== into.type) {
    throw new Error('Cannot merge accounts with different types');
  } else if (from.id === into.id) {
    throw new Error('Cannot merge an account into itself');
  }

  return sequelize.transaction(async transaction => {
    // Update orders (FROM)
    await models.Order.update({ FromCollectiveId: into.id }, { where: { FromCollectiveId: from.id } }, { transaction });

    // Update transactions
    // ... CREDIT
    await models.Transaction.update(
      { FromCollectiveId: into.id },
      { where: { FromCollectiveId: from.id } },
      { transaction },
    );

    // ... DEBIT
    await models.Transaction.update({ CollectiveId: into.id }, { where: { CollectiveId: from.id } }, { transaction });

    // Update members
    await models.Member.update(
      { MemberCollectiveId: into.id },
      { where: { MemberCollectiveId: from.id } },
      { transaction },
    );

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
