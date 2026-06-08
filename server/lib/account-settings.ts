import type Express from 'express';
import { isEqual } from 'lodash';

import { CollectiveType } from '../constants/collectives';
import { Forbidden } from '../graphql/errors';
import type { Collective } from '../models';

import twoFactorAuthLib from './two-factor-authentication';

type CollectivePageSettings = {
  sections?: Array<{ section?: string; isEnabled?: boolean }>;
  showGoals?: boolean;
  [key: string]: unknown;
};

export type AccountSettings = {
  collectivePage?: unknown;
  payoutsTwoFactorAuth?: {
    enabled?: boolean;
    rollingLimit?: number;
  };
  [key: string]: unknown;
};

export type SettingsChangeRequirements = {
  /** The resulting settings violate a product permission rule. */
  forbidden?: true;
  /** A fresh 2FA token is required before applying the change. */
  requireTwoFactorAuth?: true;
};

const ACCOUNT_TYPES_ALLOWED_TO_DISABLE_BUDGET_SECTION = [CollectiveType.FUND, CollectiveType.PROJECT];

/**
 * Returns permission and 2FA requirements for a settings update.
 * Callers must pass the fully merged settings that will be persisted.
 */
export function getSettingsChangeRequirements(
  account: Pick<Collective, 'type'>,
  oldSettings: AccountSettings | null | undefined,
  newSettings: AccountSettings | null | undefined,
): SettingsChangeRequirements {
  const requirements: SettingsChangeRequirements = {};

  if (isCollectivePageBudgetDisableForbidden(account.type, oldSettings, newSettings)) {
    requirements.forbidden = true;
  }

  if (shouldRequireTwoFactorAuthForPayoutSettingsChange(oldSettings, newSettings)) {
    requirements.requireTwoFactorAuth = true;
  }

  return requirements;
}

export function isCollectivePageBudgetDisableForbidden(
  accountType: Collective['type'],
  oldSettings: AccountSettings | null | undefined,
  newSettings: AccountSettings | null | undefined,
): boolean {
  if (ACCOUNT_TYPES_ALLOWED_TO_DISABLE_BUDGET_SECTION.includes(accountType)) {
    return false;
  }

  if (isEqual(getCollectivePageSettings(oldSettings), getCollectivePageSettings(newSettings))) {
    return false;
  }

  const budgetSection = getCollectivePageSettings(newSettings)?.sections?.find(section => section.section === 'budget');
  return Boolean(budgetSection && !budgetSection.isEnabled);
}

export function shouldRequireTwoFactorAuthForPayoutSettingsChange(
  oldSettings: AccountSettings | null | undefined,
  newSettings: AccountSettings | null | undefined,
): boolean {
  if (!oldSettings?.payoutsTwoFactorAuth?.enabled) {
    return false;
  }

  return !isEqual(oldSettings.payoutsTwoFactorAuth, newSettings?.payoutsTwoFactorAuth);
}

function getCollectivePageSettings(settings: AccountSettings | null | undefined): CollectivePageSettings | undefined {
  const collectivePage = settings?.collectivePage;
  if (!collectivePage || typeof collectivePage !== 'object') {
    return undefined;
  }

  return collectivePage as CollectivePageSettings;
}

/**
 * Ensures a settings update is allowed and satisfies any required 2FA re-authentication.
 */
export async function assertSettingsChangeAllowed(
  req: Express.Request,
  account: Pick<Collective, 'id' | 'type'>,
  oldSettings: AccountSettings | null | undefined,
  newSettings: AccountSettings | null | undefined,
): Promise<void> {
  const requirements = getSettingsChangeRequirements(account, oldSettings, newSettings);

  if (requirements.forbidden) {
    throw new Forbidden();
  }

  if (requirements.requireTwoFactorAuth) {
    await twoFactorAuthLib.validateRequest(req, {
      alwaysAskForToken: true,
      requireTwoFactorAuthEnabled: true,
      FromCollectiveId: account.id,
    });
  }
}
