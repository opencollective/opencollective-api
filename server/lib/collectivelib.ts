import * as LibTaxes from '@opencollective/taxes';
import config from 'config';
import { get, pick } from 'lodash';
import map from 'p-map';
import isURL from 'validator/lib/isURL';

import activities from '../constants/activities';
import { CollectiveType } from '../constants/collectives';
import { MODERATION_CATEGORIES } from '../constants/moderation-categories';
import { VAT_OPTIONS } from '../constants/vat';
import models, { Collective, Member, Op, sequelize } from '../models';
import Expense from '../models/Expense';
import { MemberModelInterface } from '../models/Member';
import { MemberInvitationModelInterface } from '../models/MemberInvitation';
import { OrderModelInterface } from '../models/Order';
import { PaymentMethodModelInterface } from '../models/PaymentMethod';

import logger from './logger';
import { stripHTML } from './sanitize-html';
import { md5 } from './utils';

const { USER } = CollectiveType;

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
  collectiveType: CollectiveType,
  image: string,
  args: AvatarUrlOpts,
): string => {
  const sections = [config.host.images, collectiveSlug];

  if (image) {
    sections.push(md5(image).substring(0, 7));
  }

  sections.push(collectiveType === CollectiveType.USER ? 'avatar' : 'logo');

  if (args.height) {
    sections.push(args.height);
  }

  return `${sections.join('/')}.${args.format || 'png'}`;
};

export const COLLECTIVE_SETTINGS_KEYS_LIST = [
  'allowCollectiveAdminsToEditPrivateExpenseData',
  'apply',
  'applyMessage',
  'disablePublicExpenseSubmission',
  'disablePaypalPayouts',
  'bitcoin',
  'categories',
  'collectivePage',
  'cryptoEnabled',
  'disableCustomContributions',
  'dismissedHelpMessages',
  'disableCryptoContributions',
  'earlyAccess',
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
  'customEmailMessage',
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

  /*
   * Validate customEmailMessage length.
   */
  if (settings.customEmailMessage && stripHTML(settings.customEmailMessage).length > 500) {
    return 'Custom "Thank you" email message should be less than 500 characters';
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
  'admin-panel',
  'agreement',
  'agreements',
  'api',
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
  'dashboard',
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
  'submitted-expenses',
  'faq',
  'fund',
  'gift-card',
  'gift-cards',
  'gift-cards-next',
  'gift-of-giving',
  'graphql',
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
  'login',
  'me',
  'my-account',
  'member',
  'member-invitations',
  'members',
  'oauth',
  'onboarding',
  'order',
  'orders',
  'organizations',
  'paymentmethod',
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
  'virtualcards',
  'virtual-cards',
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
export const isPastEvent = (event: Collective): boolean => {
  if (!event.endsAt) {
    return false;
  } else {
    const oneDay = 24 * 60 * 60 * 1000;
    const isOverSince = new Date().getTime() - new Date(event.endsAt).getTime();
    return isOverSince > oneDay;
  }
};

export async function isCollectiveDeletable(collective) {
  if (await collective.isHost()) {
    return false;
  }

  let user;
  if (collective.type === USER) {
    const { isLastAdminOfAnyCollective } = await sequelize.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM "Members" m
        INNER JOIN "Collectives" c ON m."CollectiveId" = c.id
        -- Try to find another admins for the same collective
        LEFT OUTER JOIN "Members" other_members
          ON m."CollectiveId" = other_members."CollectiveId"
          AND other_members.role = 'ADMIN'
          AND other_members."MemberCollectiveId" != m."MemberCollectiveId"
          AND other_members."deletedAt" IS NULL
        WHERE m.role = 'ADMIN'
        AND m."MemberCollectiveId" = :CollectiveId
        AND m."deletedAt" IS NULL
        AND c."deletedAt" IS NULL
        AND other_members.id IS NULL
      ) AS "isLastAdminOfAnyCollective"
    `,
      { plain: true, replacements: { CollectiveId: collective.id } },
    );

    if (isLastAdminOfAnyCollective) {
      return false;
    }

    user = await models.User.findOne({ where: { CollectiveId: collective.id } });
  }

  const { hasUndeletableData } = await sequelize.query(
    `
    SELECT (
      -- Children
      EXISTS (
        SELECT 1 FROM "Collectives"
        WHERE "ParentCollectiveId" = :CollectiveId
        AND "deletedAt" IS NULL
      )
      -- Expenses
      OR EXISTS (SELECT 1 FROM "Expenses" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL)
      OR EXISTS (SELECT 1 FROM "Expenses" WHERE "FromCollectiveId" = :CollectiveId AND "deletedAt" IS NULL)
      ${user ? `OR EXISTS (SELECT 1 FROM "Expenses" WHERE "UserId" = :UserId AND "deletedAt" IS NULL) ` : ''}
      -- Orders
      OR EXISTS (
        SELECT 1 FROM "Orders"
        WHERE ("CollectiveId" = :CollectiveId OR "FromCollectiveId" = :CollectiveId)
        AND "deletedAt" IS NULL
        AND status IN ('PAID', 'ACTIVE', 'CANCELLED')
      )
      -- Transactions
      OR EXISTS (
        SELECT 1 FROM "Transactions"
        WHERE "CollectiveId" = :CollectiveId
        AND "deletedAt" IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM "Transactions"
        WHERE "FromCollectiveId" = :CollectiveId
        AND "deletedAt" IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM "Transactions"
        WHERE "HostCollectiveId" = :CollectiveId
        AND "deletedAt" IS NULL
      )
    ) AS "hasUndeletableData"
  `,
    {
      plain: true,
      replacements: { CollectiveId: collective.id, UserId: user?.id },
    },
  );

  return !hasUndeletableData;
}

export async function deleteCollective(collective) {
  let user;
  if (collective.type === USER) {
    user = await models.User.findOne({ where: { CollectiveId: collective.id } });
  }

  const members = await Member.findAll({
    where: {
      [Op.or]: [{ CollectiveId: collective.id }, { MemberCollectiveId: collective.id }],
    },
  });
  await map(members, (member: MemberModelInterface) => member.destroy(), { concurrency: 3 });

  const orders = await models.Order.findAll({
    where: {
      [Op.or]: [{ FromCollectiveId: collective.id }, { CollectiveId: collective.id }],
      status: { [Op.not]: ['PAID', 'ACTIVE', 'CANCELLED'] },
    },
  });
  await map(orders, (order: OrderModelInterface) => order.destroy(), { concurrency: 3 });

  const expenses = await models.Expense.findAll({
    where: {
      [Op.or]: [{ FromCollectiveId: collective.id }, { CollectiveId: collective.id }],
      status: { [Op.not]: ['PAID', 'PROCESSING', 'SCHEDULED_FOR_PAYMENT'] },
    },
  });
  await map(expenses, (expense: Expense) => expense.destroy(), { concurrency: 3 });

  const tiers = await models.Tier.findAll({
    where: { CollectiveId: collective.id },
  });
  await map(tiers, tier => tier.destroy(), { concurrency: 3 });

  const paymentMethods = await models.PaymentMethod.findAll({
    where: { CollectiveId: collective.id },
  });
  await map(paymentMethods, (paymentMethod: PaymentMethodModelInterface) => paymentMethod.destroy(), {
    concurrency: 3,
  });

  const connectedAccounts = await models.ConnectedAccount.findAll({
    where: { CollectiveId: collective.id },
  });
  await map(connectedAccounts, connectedAccount => connectedAccount.destroy(), { concurrency: 3 });

  const memberInvitations = await models.MemberInvitation.findAll({
    where: { CollectiveId: collective.id },
  });
  await map(memberInvitations, (memberInvitation: MemberInvitationModelInterface) => memberInvitation.destroy(), {
    concurrency: 3,
  });

  await collective.destroy();

  if (user) {
    // Update user email in order to free up for future reuse
    // Split the email, username from host domain
    const splitedEmail = user.email.split('@');
    // Add the current timestamp to email username
    const newEmail = `${splitedEmail[0]}-${Date.now()}@${splitedEmail[1]}`;
    await user.update({ email: newEmail });

    await user.destroy();
  }

  await models.Activity.create({
    type: activities.COLLECTIVE_DELETED,
    CollectiveId: collective.id,
    FromCollectiveId: collective.id,
    HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
    data: collective.info,
  });

  return collective;
}
