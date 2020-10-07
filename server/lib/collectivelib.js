import * as LibTaxes from '@opencollective/taxes';
import config from 'config';
import { get, pick } from 'lodash';

import { types as CollectiveTypes } from '../constants/collectives';
import { MODERATION_CATEGORIES } from '../constants/moderation-categories';
import { VAT_OPTIONS } from '../constants/vat';

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
export function filterCollectiveSettings(settings) {
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
export function validateSettings(settings) {
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
export function isCollectiveSlugReserved(slug) {
  return collectiveSlugReservedlist.includes(slug);
}
