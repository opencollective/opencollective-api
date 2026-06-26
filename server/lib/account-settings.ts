import type Express from 'express';
import { isEqual } from 'lodash';

import { CollectiveType } from '../constants/collectives';
import { Forbidden } from '../graphql/errors';
import type { Collective } from '../models';

import twoFactorAuthLib from './two-factor-authentication';

type SettingsChangeRequirements = {
  /** The resulting settings violate a product permission rule. */
  forbidden: boolean;
  /** A fresh 2FA token is required before applying the change. */
  requireTwoFactorAuth: boolean;
};

const ACCOUNT_TYPES_ALLOWED_TO_DISABLE_BUDGET_SECTION = [CollectiveType.FUND, CollectiveType.PROJECT];

/**
 * Returns permission and 2FA requirements for a settings update.
 * Callers must pass the fully merged settings that will be persisted.
 */
export function getSettingsChangeRequirements(
  account: Pick<Collective, 'type'>,
  oldSettings: Collective['settings'] | null | undefined,
  newSettings: Collective['settings'] | null | undefined,
): SettingsChangeRequirements {
  const requirements: SettingsChangeRequirements = {
    forbidden: false,
    requireTwoFactorAuth: false,
  };

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
  oldSettings: Collective['settings'] | null | undefined,
  newSettings: Collective['settings'] | null | undefined,
): boolean {
  if (ACCOUNT_TYPES_ALLOWED_TO_DISABLE_BUDGET_SECTION.includes(accountType)) {
    return false;
  }

  const oldBudget = getCollectivePageSettings(oldSettings)?.sections?.find(s => s.section === 'budget');
  const newBudget = getCollectivePageSettings(newSettings)?.sections?.find(s => s.section === 'budget');
  const oldEnabled = oldBudget?.isEnabled ?? true;
  const newEnabled = newBudget?.isEnabled ?? true;
  return Boolean(oldEnabled && !newEnabled);
}

export function shouldRequireTwoFactorAuthForPayoutSettingsChange(
  oldSettings: Collective['settings'] | null | undefined,
  newSettings: Collective['settings'] | null | undefined,
): boolean {
  if (!oldSettings?.payoutsTwoFactorAuth?.enabled) {
    return false;
  }

  return !isEqual(oldSettings.payoutsTwoFactorAuth, newSettings?.payoutsTwoFactorAuth);
}

function getCollectivePageSettings(
  settings: Collective['settings'] | null | undefined,
): Collective['settings']['collectivePage'] | undefined {
  const collectivePage = settings?.collectivePage;
  if (!collectivePage || typeof collectivePage !== 'object') {
    return undefined;
  }

  return collectivePage;
}

/**
 * Ensures a settings update is allowed and satisfies any required 2FA re-authentication.
 */
export async function assertSettingsChangeAllowed(
  req: Express.Request,
  account: Pick<Collective, 'id' | 'type'>,
  oldSettings: Collective['settings'] | null | undefined,
  newSettings: Collective['settings'] | null | undefined,
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
