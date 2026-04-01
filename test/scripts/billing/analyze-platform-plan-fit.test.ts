import { expect } from 'chai';

import { classifyRow, parseMonthOption } from '../../../scripts/billing/analyze-platform-plan-fit';
import { PlatformSubscriptionPlan, PlatformSubscriptionTiers } from '../../../server/constants/plans';
import { BillingMonth, getCostOptimalPlatformTiersForUtilization } from '../../../server/models/PlatformSubscription';

function tier(id: string): PlatformSubscriptionPlan {
  const t = PlatformSubscriptionTiers.find(x => x.id === id);
  if (!t) {
    throw new Error(`Unknown tier ${id}`);
  }
  return { ...t, basePlanId: t.id } as PlatformSubscriptionPlan;
}

describe('scripts/billing/analyze-platform-plan-fit > parseMonthOption', () => {
  it('parses YYYY-MM to year and BillingMonth (0-based)', () => {
    expect(parseMonthOption('2026-03')).to.deep.equal({ year: 2026, month: BillingMonth.MARCH });
    expect(parseMonthOption('2024-01')).to.deep.equal({ year: 2024, month: BillingMonth.JANUARY });
  });

  it('throws for invalid month strings', () => {
    expect(() => parseMonthOption('not-a-month')).to.throw(/Invalid --month/);
    expect(() => parseMonthOption('2026-13')).to.throw(/Invalid --month/);
    expect(() => parseMonthOption('26-03')).to.throw(/Invalid --month/);
  });
});

describe('scripts/billing/analyze-platform-plan-fit > classifyRow', () => {
  const zeroUtil = { activeCollectives: 0, expensesPaid: 0 };

  it('returns review when there are no suggestions', () => {
    expect(classifyRow({ suggestions: [], currentPlan: { id: 'discover-1' }, utilization: zeroUtil })).to.deep.equal({
      bucket: 'review',
      reason: 'no_suggestions',
    });
  });

  it('returns ok when current catalog id is among optimal suggestions', () => {
    const suggestions = getCostOptimalPlatformTiersForUtilization(zeroUtil);
    expect(suggestions.length).to.be.at.least(1);
    const { bucket, reason } = classifyRow({
      suggestions,
      currentPlan: { id: 'discover-1' },
      utilization: zeroUtil,
    });
    expect(bucket).to.equal('ok');
    expect(reason).to.equal(undefined);
  });

  it('returns downgrade when current tier is above the cost-optimal tier', () => {
    const suggestions = getCostOptimalPlatformTiersForUtilization(zeroUtil);
    const primary = suggestions[0];
    const { bucket } = classifyRow({
      suggestions,
      currentPlan: tier('pro-50'),
      utilization: zeroUtil,
    });
    expect(bucket).to.equal('downgrade');
    expect(primary.plan.id).to.equal('discover-1');
  });

  it('returns upgrade when cost-optimal tier is above the current tier', () => {
    const basic5 = tier('basic-5');
    const { bucket } = classifyRow({
      suggestions: [{ plan: basic5, estimatedPricePerMonth: basic5.pricing.pricePerMonth }],
      currentPlan: { id: 'discover-1', type: tier('discover-1').type },
      utilization: { activeCollectives: 100, expensesPaid: 1000 },
    });
    expect(bucket).to.equal('upgrade');
  });

  it('returns review for an unknown / non-catalog current plan id', () => {
    const suggestions = getCostOptimalPlatformTiersForUtilization(zeroUtil);
    const { bucket, reason } = classifyRow({
      suggestions,
      currentPlan: { id: 'custom-unknown-slug' },
      utilization: zeroUtil,
    });
    expect(bucket).to.equal('review');
    expect(reason).to.equal('custom_or_unknown_tier');
  });
});
