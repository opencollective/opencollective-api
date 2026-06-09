import { expect } from 'chai';

import { CollectiveType } from '../../../server/constants/collectives';
import {
  getSettingsChangeRequirements,
  isCollectivePageBudgetDisableForbidden,
  shouldRequireTwoFactorAuthForPayoutSettingsChange,
} from '../../../server/lib/account-settings';

describe('server/lib/account-settings', () => {
  describe('shouldRequireTwoFactorAuthForPayoutSettingsChange', () => {
    it('returns false when payout 2FA is not enabled', () => {
      const oldSettings = { payoutsTwoFactorAuth: { enabled: false, rollingLimit: 50000 } };
      const newSettings = { payoutsTwoFactorAuth: { enabled: false, rollingLimit: 999999999 } };

      expect(shouldRequireTwoFactorAuthForPayoutSettingsChange(oldSettings, newSettings)).to.be.false;
    });

    it('returns false when payout 2FA is enabled but unchanged', () => {
      const settings = { payoutsTwoFactorAuth: { enabled: true, rollingLimit: 50000 } };

      expect(shouldRequireTwoFactorAuthForPayoutSettingsChange(settings, settings)).to.be.false;
    });

    it('returns true when payout 2FA is enabled and rollingLimit changes', () => {
      const oldSettings = { payoutsTwoFactorAuth: { enabled: true, rollingLimit: 50000 } };
      const newSettings = { payoutsTwoFactorAuth: { enabled: true, rollingLimit: 999999999 } };

      expect(shouldRequireTwoFactorAuthForPayoutSettingsChange(oldSettings, newSettings)).to.be.true;
    });
  });

  describe('isCollectivePageBudgetDisableForbidden', () => {
    const budgetDisabledCollectivePage = {
      sections: [{ section: 'budget', isEnabled: false }],
    };

    it('allows FUND accounts to disable the budget section', () => {
      expect(
        isCollectivePageBudgetDisableForbidden(
          CollectiveType.FUND,
          {},
          { collectivePage: budgetDisabledCollectivePage },
        ),
      ).to.be.false;
    });

    it('forbids COLLECTIVE accounts from newly disabling the budget section', () => {
      const oldSettings = { collectivePage: { sections: [{ section: 'budget', isEnabled: true }] } };
      const newSettings = { collectivePage: budgetDisabledCollectivePage };

      expect(isCollectivePageBudgetDisableForbidden(CollectiveType.COLLECTIVE, oldSettings, newSettings)).to.be.true;
    });

    it('does not block unrelated settings changes when collectivePage is unchanged', () => {
      const oldSettings = {
        collectivePage: budgetDisabledCollectivePage,
        apply: false,
      };
      const newSettings = {
        collectivePage: budgetDisabledCollectivePage,
        apply: true,
      };

      expect(isCollectivePageBudgetDisableForbidden(CollectiveType.COLLECTIVE, oldSettings, newSettings)).to.be.false;
    });

    it('does not block when another collectivePage field changes but budget isEnabled stays the same', () => {
      const oldSettings = {
        collectivePage: { sections: [{ section: 'budget', isEnabled: true }], showGoals: false },
      };
      const newSettings = {
        collectivePage: { sections: [{ section: 'budget', isEnabled: true }], showGoals: true },
      };

      expect(isCollectivePageBudgetDisableForbidden(CollectiveType.COLLECTIVE, oldSettings, newSettings)).to.be.false;
    });
  });

  describe('getSettingsChangeRequirements', () => {
    it('combines permission and 2FA requirements', () => {
      const oldSettings = {
        payoutsTwoFactorAuth: { enabled: true, rollingLimit: 50000 },
        collectivePage: { sections: [{ section: 'budget', isEnabled: true }] },
      };
      const newSettings = {
        payoutsTwoFactorAuth: { enabled: true, rollingLimit: 999999999 },
        collectivePage: { sections: [{ section: 'budget', isEnabled: false }] },
      };

      expect(
        getSettingsChangeRequirements({ type: CollectiveType.COLLECTIVE }, oldSettings, newSettings),
      ).to.deep.equal({
        forbidden: true,
        requireTwoFactorAuth: true,
      });
    });

    it('returns no requirements for unrelated settings changes', () => {
      const oldSettings = { apply: false };
      const newSettings = { apply: true };

      expect(
        getSettingsChangeRequirements({ type: CollectiveType.COLLECTIVE }, oldSettings, newSettings),
      ).to.deep.equal({
        forbidden: false,
        requireTwoFactorAuth: false,
      });
    });

    it('returns no requirements when payout 2FA is enabled but unchanged', () => {
      const settings = { payoutsTwoFactorAuth: { enabled: true, rollingLimit: 50000 } };

      expect(getSettingsChangeRequirements({ type: CollectiveType.COLLECTIVE }, settings, settings)).to.deep.equal({
        forbidden: false,
        requireTwoFactorAuth: false,
      });
    });

    it('returns no requirements when a FUND disables the budget section', () => {
      const oldSettings = { collectivePage: { sections: [{ section: 'budget', isEnabled: true }] } };
      const newSettings = { collectivePage: { sections: [{ section: 'budget', isEnabled: false }] } };

      expect(getSettingsChangeRequirements({ type: CollectiveType.FUND }, oldSettings, newSettings)).to.deep.equal({
        forbidden: false,
        requireTwoFactorAuth: false,
      });
    });

    it('returns no requirements when collectivePage changes but budget isEnabled stays the same', () => {
      const oldSettings = {
        collectivePage: { sections: [{ section: 'budget', isEnabled: true }], showGoals: false },
      };
      const newSettings = {
        collectivePage: { sections: [{ section: 'budget', isEnabled: true }], showGoals: true },
      };

      expect(
        getSettingsChangeRequirements({ type: CollectiveType.COLLECTIVE }, oldSettings, newSettings),
      ).to.deep.equal({
        forbidden: false,
        requireTwoFactorAuth: false,
      });
    });
  });
});
