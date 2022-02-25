import * as LibTaxes from '@opencollective/taxes';
import config from 'config';
import { get, pick } from 'lodash';
import isURL from 'validator/lib/isURL';

import { types as CollectiveTypes } from '../constants/collectives';
import { MODERATION_CATEGORIES } from '../constants/moderation-categories';
import { VAT_OPTIONS } from '../constants/vat';
import models from '../models';

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
  'cryptoEnabled',
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
  'expenseTypes',
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

  if (settings?.tos && !isURL(settings.tos)) {
    return 'Enter a valid URL. The URL should have the format https://opencollective.com/';
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
  'root-actions',
  'search',
  'signin',
  'signup',
  'subscriptions',
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
